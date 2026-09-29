#!/usr/bin/env python3
"""Compile an immutable App revision against a selected Web's live fixtures."""

import argparse
import base64
import contextlib
import hashlib
import json
import os
import plistlib
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["ContractReadinessTests", "APIClientAuthAndErrorTests", "APIClientSessionListTests",
         "APIClientSessionMutationTests", "SSEClientTests", "StreamReconnectContractTests"]
LIVE_CLASS, LIVE_TEST = "APIClientSessionListTests", "testLiveUpstreamContractResponsesDecodeWhenSupplied"


def commit(ref):
    return subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"], text=True).strip()


def runner_avoids_clones(app_sha):
    """Whether this App revision's own test-ios runs one worker on the leased simulator without cloning it.

    Older runners clone even for one worker, and back-to-back runs on a reused checkout race the previous
    clone's teardown, so only these revisions may share a warm checkout (TAL-304)."""
    for path in ("app/scripts/test-ios", "scripts/test-ios"):
        try:
            script = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{app_sha}:{path}"], text=True,
                                             stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            continue
        return "(( TALARIA_TEST_WORKER_COUNT > 1 )) && parallel_testing=YES" in script
    return False


def disable_simulator_clones(app):
    """Run an older App's own test-ios on the leased simulator itself when only one worker is requested.

    Those runners hardcode parallel testing, which clones the simulator even for one worker and races the
    previous run's clone teardown (TAL-323). Only a disposable checkout is edited."""
    runner = app / "scripts/test-ios"
    script = runner.read_text()
    if "-parallel-testing-enabled YES" not in script:
        raise ValueError("older App runner no longer declares -parallel-testing-enabled YES; update the TAL-323 shim")
    runner.write_text(script.replace("-parallel-testing-enabled YES", "-parallel-testing-enabled NO"))


def package_classes(app, tests):
    """The selected classes this App revision tests with `swift test` in its TalariaKit package (TAL-399).

    Older revisions have no package and host every class in TalariaTests."""
    directory = app / "TalariaKit/Tests/TalariaKitTests"
    declared = {name for path in directory.rglob("*.swift")
                for name in re.findall(r"^\s*(?:final\s+)?class\s+(\w+)\s*:", path.read_text(), re.MULTILINE)}
    return [name for name in tests if name in declared]


def preboot_simulator(app):
    """Boot the explicit IOS_SIMULATOR_ID in the background while the Web is probed and the App builds (TAL-414).

    Older runners lease only a Shutdown device, so the disposable checkout's pool helper also accepts that booted one.
    Returns the boot process, or None when there is no explicit device or the helper is not the known one."""
    device, pool = os.environ.get("IOS_SIMULATOR_ID"), app / "scripts/ios-simulator-pool"
    shutdown_only = '[[ "$candidate_state" == Shutdown ]] || continue'
    booted_too = '[[ "$candidate_state" == Shutdown || "$candidate_state" == Booted ]] || continue'
    if not device or not pool.is_file():
        return None
    helper = pool.read_text()
    if shutdown_only in helper:
        pool.write_text(helper.replace(shutdown_only, booted_too))
    elif booted_too not in helper:
        return None
    return subprocess.Popen(["xcrun", "simctl", "bootstatus", device, "-b"], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)


def prebuild_hosted(app, output):
    """Compile an older App's hosted tests while the Web is probed and the simulator boots (TAL-414).

    The settings mirror the App's own test-ios with a placeholder fixture, so its build afterwards only rewrites the
    Info.plists and re-signs (seconds). test-ios stays the authority: a failure here, or settings that drifted, only
    cost its own full build again."""
    with (output / "app-prebuild.log").open("w") as log:
        subprocess.run(["xcodebuild", "build-for-testing", "-quiet", "-project", "Talaria.xcodeproj", "-scheme", "Talaria",
                        "-destination", f"platform=iOS Simulator,id={os.environ['IOS_SIMULATOR_ID']}",
                        "-derivedDataPath", str(app / ".codex-tmp/xctest/derived-data"), "-disableAutomaticPackageResolution",
                        "-enableCodeCoverage", "NO", "APP_IDENTIFIER_SUFFIX=.xctest", "INFOPLIST_KEY_CFBundleDisplayName=base64:",
                        "SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) TALARIA_LIVE_CONTRACT"],
                       cwd=app, stdout=log, stderr=subprocess.STDOUT, check=False)


def build_package_tests(app, output):
    with (output / "app-package-build.log").open("w") as log:
        subprocess.run(["swift", "build", "--package-path", str(app / "TalariaKit"), "--build-tests"],
                       cwd=app, stdout=log, stderr=subprocess.STDOUT, check=True)


def run_package_tests(app, classes, responses, output):
    """Run the package's contract classes on macOS against the live fixture; every class and the live test must pass."""
    log_path = output / "app-package-tests.log"
    with log_path.open("w") as log:
        subprocess.run(["swift", "test", "--package-path", str(app / "TalariaKit"),
                        "--filter", "^TalariaKitTests\\.(" + "|".join(classes) + ")/"],
                       cwd=app, env={**os.environ, "TALARIA_LIVE_CONTRACT_RESPONSES": str(responses)},
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    text = log_path.read_text()
    for name in classes:
        if f"Test Suite '{name}' passed" not in text:
            raise ValueError(f"package gate did not execute {name}")
    if LIVE_CLASS in classes and f"Test Case '-[TalariaKitTests.{LIVE_CLASS} {LIVE_TEST}]' passed" not in text:
        raise ValueError("previous App did not decode the live Web fixtures")


def run_package_suite(app, responses, output):
    """The UI suite's package job on this checkout (TAL-414): every TalariaKit test but the fuzz soak, against the live
    fixture, whose decoding test must pass."""
    log_path = output / "app-package-suite.log"
    with log_path.open("w") as log:
        subprocess.run(["swift", "test", "--package-path", str(app / "TalariaKit"), "--skip-build",
                        "--skip", "UntrustedInputFuzzSoakTests"],
                       cwd=app, env={**os.environ, "TALARIA_LIVE_CONTRACT_RESPONSES": str(responses)},
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    if f"Test Case '-[TalariaKitTests.{LIVE_CLASS} {LIVE_TEST}]' passed" not in log_path.read_text():
        raise ValueError("the package suite did not decode the live Web fixtures")


def verify_hosted(app, hosted, responses, output):
    """Run the simulator-hosted contract classes with the App's own test-ios; each class and the live test must pass."""
    env = {**os.environ, "_TALARIA_ENV_LOADED": "1",
           "TALARIA_UPSTREAM_CONTRACT_RESPONSES": "base64:" + base64.b64encode(responses.read_bytes()).decode()}
    with (output / "app-tests.log").open("w") as log:
        subprocess.run([str(app / "scripts/test-ios"), *("TalariaTests/" + name for name in hosted)],
                       cwd=app, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    result_path = re.search(r"^Result bundle: (.+)$", (output / "app-tests.log").read_text(), re.MULTILINE)
    if result_path is None:
        raise ValueError("native runner did not identify its result bundle")
    evidence = {}
    for kind in ("summary", "tests"):
        payload = json.loads(subprocess.check_output([
            "xcrun", "xcresulttool", "get", "test-results", kind, "--path", result_path[1], "--compact",
        ]))
        (output / f"app-{kind}.json").write_text(json.dumps(payload, indent=2) + "\n")
        evidence[kind] = payload
    if evidence["summary"].get("result") != "Passed" or evidence["summary"].get("failedTests"):
        raise ValueError("native contract tests did not pass")
    cases = {}

    def collect(node):
        if isinstance(node, dict):
            if node.get("nodeType") == "Test Case":
                cases[node["nodeIdentifier"]] = node["result"]
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)

    collect(evidence["tests"])
    for name in hosted:
        if not any(key.startswith(name + "/") and result == "Passed" for key, result in cases.items()):
            raise ValueError(f"native gate did not execute {name}")
    if LIVE_CLASS in hosted:
        if cases.get(f"{LIVE_CLASS}/{LIVE_TEST}()") != "Passed":
            raise ValueError("previous App did not decode the live Web fixtures")
        products = app / ".codex-tmp/xctest/derived-data/Build/Products"
        plists = list(products.glob("**/TalariaTests.xctest/Info.plist"))
        if not any(plistlib.loads(path.read_bytes()).get("CFBundleDisplayName") == env["TALARIA_UPSTREAM_CONTRACT_RESPONSES"] for path in plists):
            raise ValueError("live fixtures were not embedded in the executed App test bundle")


def probe_web(web_sha, responses, log):
    """Probe a Web source with the harness from its own revision.

    Each revision's harness starts the Web beside it: the Python server before TAL-245, the Node server after,
    so a retained older Web cannot be started by the current harness."""
    with tempfile.TemporaryDirectory(prefix="talaria-web-source-") as temporary:
        source = Path(temporary) / "source"
        subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(source)], check=True)
        subprocess.run(["git", "-C", str(source), "checkout", "--quiet", "--detach", web_sha], check=True)
        subprocess.run([
            str(source / "app/scripts/validate-upstream-contract"), "--server-only", "--responses-output", str(responses),
        ], cwd=source / "app", stdout=log, stderr=subprocess.STDOUT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-ref", required=True)
    parser.add_argument("--web-ref", required=True)
    parser.add_argument("--shared-contracts", action="store_true", help="Also exercise monorepo App/Relay fixtures.")
    parser.add_argument("--output", type=Path, required=True, help="New directory for retained verification evidence.")
    parser.add_argument("--app-checkout", type=Path,
                        help="Reusable App checkout (and warm DerivedData) shared by consecutive runs of one App revision.")
    parser.add_argument("--package-suite", action="store_true",
                        help="Also run every TalariaKit test but the fuzz soak against the live fixture (the UI suite's package job).")
    args = parser.parse_args()
    tests = [*TESTS, *(["SharedContractTests"] if args.shared_contracts else [])]
    app_sha, web_sha = commit(args.app_ref), commit(args.web_ref)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    responses = output / "responses.json"
    with contextlib.ExitStack() as stack:
        if args.app_checkout and runner_avoids_clones(app_sha):
            checkout = args.app_checkout.resolve()
        else:
            checkout = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="talaria-previous-app-"))) / "source"
        reused = (checkout / ".git").exists() and subprocess.check_output(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip() == app_sha
        if not reused:
            subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(checkout)], check=True)
            subprocess.run(["git", "-C", str(checkout), "checkout", "--quiet", "--detach", app_sha], check=True)
        app = checkout / "app" if (checkout / "app/Talaria.xcodeproj").is_dir() else checkout
        if not (app / "Talaria.xcodeproj").is_dir():
            raise ValueError("selected revision does not contain the App project")
        if not runner_avoids_clones(app_sha) and os.environ.get("TALARIA_TEST_WORKER_COUNT", "2") == "1":
            disable_simulator_clones(app)
        if args.shared_contracts:
            web_fixture = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{web_sha}:contracts/fixtures/web-session.json"])
            (checkout / "contracts/fixtures/web-session.json").write_bytes(web_fixture)
        packaged = package_classes(app, tests)
        hosted = [name for name in tests if name not in packaged]
        if args.package_suite and not packaged:
            raise ValueError("the package suite needs an App revision with TalariaKit")
        started, seconds = time.monotonic(), {}

        def timed(name, function, *arguments):
            begin = time.monotonic()
            try:
                return function(*arguments)
            finally:
                seconds[name] = round(time.monotonic() - begin)

        # The Web probe, the package or App build and the simulator boot need nothing of each other, so they run at
        # once (TAL-408, TAL-414); the tests follow.
        # ponytail: a failed probe still waits for the builds to finish; kill them if failures become common.
        boot = preboot_simulator(app) if hosted else None
        if boot:
            stack.callback(lambda: boot.poll() is None and boot.kill())
        with ThreadPoolExecutor(max_workers=3) as pool:
            builds = [pool.submit(timed, "packageBuild", build_package_tests, app, output)] if packaged else []
            if boot:
                # test-ios boots the device itself when this boot failed.
                builds += [pool.submit(timed, "appBuild", prebuild_hosted, app, output),
                           pool.submit(timed, "simulatorBoot", boot.wait)]
            with (output / "web-probe.log").open("w") as log:
                timed("webProbe", probe_web, web_sha, responses, log)
            for build in builds:
                build.result()
        if packaged:
            timed("packageTests", run_package_tests, app, packaged, responses, output)
        if args.package_suite:
            timed("packageSuite", run_package_suite, app, responses, output)
        # A revision whose package holds every selected class needs no simulator; test-ios with no class would run
        # the whole hosted suite.
        if hosted:
            timed("hostedTests", verify_hosted, app, hosted, responses, output)
        seconds["total"] = round(time.monotonic() - started)
    record = {"appSourceRevision": app_sha, "webSourceRevision": web_sha, "result": "success",
              "fixturesSha256": hashlib.sha256(responses.read_bytes()).hexdigest(), "testClasses": tests, "seconds": seconds}
    (output / "verification.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))


if __name__ == "__main__":
    main()
