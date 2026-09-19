#!/usr/bin/env python3
"""Classify a Git diff for component CI; unknown/shared paths run all checks."""

import argparse
import plistlib
import subprocess


COMPONENTS = {"app", "web", "relay", "contracts"}
INTERFACES = (
    "app/Talaria/Networking/", "app/Talaria/Models/", "app/Talaria/LiveActivities/",
    "web/api/", "relay/convex/", "contracts/",
)


def same_app_scene(before, after):
    # Startup diagnostics precede the Scene; changes to the rendered Scene or
    # its helpers still require the complete UI suite.
    marker = "var body: some Scene"
    return marker in before and marker in after and before.split(marker, 1)[1] == after.split(marker, 1)[1]


def app_ui_required(paths, scene_unchanged=False, metadata_only_plists=()):
    for path in paths:
        if not path.startswith("app/"):
            if path.startswith(("web/", "relay/", "contracts/", "releases/", "scripts/", "docs/", "changelog.d/", ".github/", ".agents/")) or "/" not in path and path.endswith(".md"):
                continue
            return True
        if path == "app/Talaria/TalariaApp.swift":
            if not scene_unchanged:
                return True
        elif path.startswith(("app/Talaria/Networking/", "app/Talaria/Models/", "app/Talaria/Config/",
                              "app/Talaria/Persistence/", "app/Talaria/Sync/", "app/Talaria/LiveActivities/",
                              "app/TalariaTests/", "app/ci/", "app/scripts/", "app/docs/", "app/changelog.d/",
                              "app/Talaria.xcodeproj/")):
            continue
        elif path in metadata_only_plists or (path.count("/") == 1 and path.endswith(".md")):
            continue
        else:
            return True
    return False


def same_plist_ui(before, after):
    documents = [plistlib.loads(value) for value in (before, after)]
    for document in documents:
        document.pop("TalariaRelease", None)
    return documents[0] == documents[1]


def affected(paths):
    selected = set()
    for path in paths:
        component = path.split("/", 1)[0]
        if component not in {"app", "web", "relay"} or path.startswith(INTERFACES):
            return COMPONENTS
        selected.add(component)
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        assert affected(["app/Talaria/Features/Chat/ChatView.swift"]) == {"app"}
        assert affected(["web/frontend/src/main.tsx"]) == {"web"}
        assert affected(["relay/tests/crypto.test.ts"]) == {"relay"}
        assert affected(["docs/contributing.md"]) == COMPONENTS
        assert affected(["contracts/session.json"]) == COMPONENTS
        assert affected(["web/api/routes.py"]) == COMPONENTS
        assert affected(["app/Talaria/LiveActivities/TalariaRelay.swift"]) == COMPONENTS
        assert affected(["web/frontend/src/main.tsx", "relay/tests/crypto.test.ts"]) == {"web", "relay"}
        assert affected([".github/workflows/pr-ci.yml"]) == COMPONENTS
        assert affected([]) == set()
        assert not app_ui_required(["app/Talaria/Networking/APIClient.swift"])
        assert not app_ui_required(["app/Talaria/Resources/Info.plist"], metadata_only_plists=["app/Talaria/Resources/Info.plist"])
        assert app_ui_required(["app/Talaria/Resources/Info.plist"])
        assert same_plist_ui(plistlib.dumps({}), plistlib.dumps({"TalariaRelease": {"version": "1.0.0"}}))
        assert not same_plist_ui(plistlib.dumps({}), plistlib.dumps({"UISupportedInterfaceOrientations": ["portrait"]}))
        assert app_ui_required(["app/Talaria/Features/Chat/ChatView.swift"])
        assert app_ui_required(["app/Talaria/ContentView.swift"])
        assert app_ui_required(["app/TalariaUITests/TalariaUITests.swift"])
        assert app_ui_required(["app/TalariaLiveActivityWidget/ProviderQuotaWidgetView.swift"])
        assert app_ui_required(["app/TalariaShareExtension/ShareViewController.swift"])
        assert app_ui_required(["app/NewComponent/Unknown.swift"])
        assert app_ui_required(["new-component/runtime.swift"])
        assert not app_ui_required(["app/Talaria/TalariaApp.swift"], scene_unchanged=True)
        assert app_ui_required(["app/Talaria/TalariaApp.swift"])
        assert same_app_scene("init() {}\nvar body: some Scene { Main() }", "init() { log() }\nvar body: some Scene { Main() }")
        assert not same_app_scene("var body: some Scene { Main() }", "var body: some Scene { Other() }")
        assert not same_app_scene("unknown", "unknown")
        print("CI routing checks passed.")
        return
    if not args.base:
        parser.error("--base is required")
    paths = subprocess.check_output([
        "git", "diff", "--no-renames", "--name-only", "-z", args.base, args.head, "--",
    ]).decode().split("\0")
    paths = list(filter(None, paths))
    selected = affected(paths)
    scene_unchanged = False
    entry = "app/Talaria/TalariaApp.swift"
    if entry in paths:
        try:
            before, after = [subprocess.check_output(["git", "show", f"{ref}:{entry}"]).decode() for ref in (args.base, args.head)]
            scene_unchanged = same_app_scene(before, after)
        except subprocess.CalledProcessError:
            pass  # Missing/unreadable entry points require the full UI suite.
    metadata_only_plists = []
    for path in paths:
        if path.startswith("app/") and path.endswith("/Resources/Info.plist"):
            try:
                before, after = [subprocess.check_output(["git", "show", f"{ref}:{path}"]) for ref in (args.base, args.head)]
                if same_plist_ui(before, after):
                    metadata_only_plists.append(path)
            except (subprocess.CalledProcessError, ValueError, plistlib.InvalidFileException, AttributeError, TypeError):
                pass
    print(f"app_ui={str(app_ui_required(paths, scene_unchanged, metadata_only_plists)).lower()}")
    for component in sorted(COMPONENTS):
        print(f"{component}={str(component in selected).lower()}")


if __name__ == "__main__":
    main()
