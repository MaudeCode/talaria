"""Resolve component identities before builds; assemble only successful receipts."""

import json
import plistlib
import re
import subprocess
from copy import deepcopy

from jsonschema import Draft202012Validator
from release_set import COMPONENTS, SCHEMA, VALIDATOR, require_version_advance, validate

SHA = re.compile(r"[a-f0-9]{40}")
VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
CONTRACT_PEERS = {"appWeb": ("app", "web"), "webRelay": ("web", "relay"),
                  "appRelay": ("app", "relay"), "activityScene": ("app", "relay")}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def read_at(root, source, path):
    raw = subprocess.check_output(["git", "-C", str(root), "show", f"{source}:{path}"])
    return plistlib.loads(raw) if path.endswith(".plist") else json.loads(raw)


def validate_request(request):
    required = {"sourceRevision", "tags", "relayDeploymentId"}
    if not isinstance(request, dict) or set(request) != required:
        raise ValueError("plan requires only sourceRevision, tags and relayDeploymentId")
    source = request["sourceRevision"]
    if not isinstance(source, str) or not SHA.fullmatch(source):
        raise ValueError("sourceRevision must be an immutable commit")
    if not isinstance(request["tags"], dict) or set(request["tags"]) != set(COMPONENTS):
        raise ValueError("select one tag for every component")
    deployment = request["relayDeploymentId"]
    if not isinstance(deployment, str) or not re.fullmatch(r"[a-z][a-z0-9-]+", deployment):
        raise ValueError("Relay requires its deployment identity")
    for name, tag in request["tags"].items():
        prefix = r"web-(?:exp-)?v" if name == "web" else name + "-v"
        if not isinstance(tag, str) or not re.fullmatch(prefix + VERSION, tag):
            raise ValueError(f"invalid {name} tag")


def resolve(root, request, previous=None):
    """Resolve immutable local refs. Signature/remote-CI authorization is separate."""
    validate_request(request)
    source, deployment = request["sourceRevision"], request["relayDeploymentId"]
    if git(root, "rev-parse", f"{source}^{{commit}}") != source:
        raise ValueError("sourceRevision is not a commit")
    if previous is not None:
        VALIDATOR.validate(previous)
        if previous["status"] != "complete" or previous["releaseSet"] == source:
            raise ValueError("previous must be a different completed release set")

    plan = {"releaseSet": source, "previousReleaseSet": previous["releaseSet"] if previous else None,
            "components": {}, "changed": {}, "contracts": {key: {} for key in CONTRACT_PEERS}}
    for name in COMPONENTS:
        tag = request["tags"][name]
        prefix = r"web-(?:exp-)?v" if name == "web" else name + "-v"
        if not isinstance(tag, str) or not re.fullmatch(prefix + VERSION, tag):
            raise ValueError(f"invalid {name} tag")
        revision = git(root, "rev-parse", f"refs/tags/{tag}^{{commit}}")
        prior = previous["components"][name] if previous else None
        changed = prior is None or tag != prior["tag"]
        plan["changed"][name] = changed
        if not changed:
            if revision != prior["sourceRevision"]:
                raise ValueError(f"reused {name} tag moved")
            component = deepcopy(prior)
            capabilities = {contract: previous["contracts"][contract][name]
                            for contract, peers in CONTRACT_PEERS.items() if name in peers}
            if name == "web":
                plan["agent"] = deepcopy(previous["agent"])
            if name == "relay" and deployment != component["deploymentId"]:
                raise ValueError("unchanged Relay cannot move deployments")
        else:
            if prior:
                require_version_advance(tag, prior["tag"])
            if revision != source:
                raise ValueError(f"changed {name} must use the release-set source")
            component = {"tag": tag, "version": tag.split("-v")[-1],
                         "sourceRevision": source, "releaseSet": source}
            if name == "app":
                capabilities = read_at(root, source, "app/Talaria/Resources/Info.plist")["TalariaRelease"]["contracts"]
                # Dry-run build identity; production takes the actual selected
                # App Store Connect build number from the successful build job.
                component["buildNumber"] = (prior["buildNumber"] + 1) if prior else 1
            elif name == "web":
                versions = read_at(root, source, "web/api/contract_versions.json")
                capabilities = {"appWeb": [versions["appWeb"]["fixtureVersion"]], "webRelay": [versions["webRelay"]["protocolVersion"]]}
                pin = read_at(root, source, "web/api/agent_dependency.json")
                plan["agent"] = {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]}
                component["upstreamBase"] = git(root, "show", f"{source}:web/UPSTREAM_BASE_SHA")
                if not SHA.fullmatch(component["upstreamBase"]):
                    raise ValueError("Web upstream base must be immutable")
                git(root, "merge-base", "--is-ancestor", component["upstreamBase"], source)
            else:
                capabilities = read_at(root, source, "relay/convex/releaseInfo.json")["contracts"]
                component.update(deploymentId=deployment, deployedRevision=None)
        plan["components"][name] = component
        for contract, peers in CONTRACT_PEERS.items():
            if name in peers:
                plan["contracts"][contract][name] = deepcopy(capabilities[contract])
    if not any(plan["changed"].values()):
        raise ValueError("select at least one changed component")
    for key in ("contracts", "agent"):
        Draft202012Validator({"$defs": SCHEMA["$defs"], **SCHEMA["properties"][key]}).validate(plan[key])
    for contract, peers in plan["contracts"].items():
        if not set.intersection(*(set(values) for values in peers.values())):
            raise ValueError(f"incompatible {contract} capabilities")
    if previous:
        for contract in ("appWeb", "appRelay", "activityScene"):
            server = "web" if contract == "appWeb" else "relay"
            if not set(previous["contracts"][contract]["app"]) & set(plan["contracts"][contract][server]):
                raise ValueError(f"previous App is incompatible with {contract}")
    return plan


def assemble(plan, receipts, notes, previous=None, *, complete=False):
    """Combine job outputs; missing/failed gates cannot become a completed set."""
    document = {"schemaVersion": 1, "status": "complete" if complete else "candidate",
                **{key: deepcopy(plan[key]) for key in ("releaseSet", "previousReleaseSet", "components", "contracts", "agent")},
                "notes": deepcopy(notes), "evidence": []}
    document["notes"]["combined"] = "\n\n".join(f"## {name.title()}\n\n{notes[name].strip()}" for name in COMPONENTS)
    # Artifact download order is not job execution order. Build identities must
    # be applied before comparing publication readbacks with those identities.
    ordered = sorted(receipts, key=lambda item: item.get("gate", "").startswith(("deploy", "publish", "upload")))
    app_digest = None
    for receipt in ordered:
        if receipt.get("sourceRevision") != plan["releaseSet"] or receipt.get("result") != "success":
            raise ValueError("failed or wrong-source receipt")
        gate = receipt["gate"]
        name = next((name for name in COMPONENTS if gate == f"build{name.title()}"), None)
        if name:
            if not plan["changed"][name] or receipt.get("tag") != plan["components"][name]["tag"]:
                raise ValueError("build receipt must identify a changed component tag")
            if name == "web":
                document["components"][name]["image"] = receipt["image"]
            elif name == "app":
                document["components"][name]["buildNumber"] = receipt["buildNumber"]
                app_digest = receipt.get("ipaSha256")
            elif receipt.get("deploymentId") != plan["components"][name]["deploymentId"]:
                raise ValueError("Relay build target differs from plan")
        if gate == "deployRelay":
            relay = document["components"]["relay"]
            if receipt.get("deploymentId") != relay["deploymentId"] or receipt.get("deployedRevision") != relay["sourceRevision"]:
                raise ValueError("Relay deployment readback differs from plan")
            relay["deployedRevision"] = receipt["deployedRevision"]
        if gate == "publishWeb":
            web = document["components"]["web"]
            if receipt.get("image") != web.get("image") or receipt.get("tag") != web["tag"]:
                raise ValueError("published Web image differs from its build")
        if gate == "uploadApp":
            app = document["components"]["app"]
            if receipt.get("buildNumber") != app["buildNumber"] or receipt.get("tag") != app["tag"]:
                raise ValueError("uploaded App differs from its build")
            if not isinstance(app_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", app_digest) or receipt.get("ipaSha256") != app_digest:
                raise ValueError("uploaded IPA differs from its build")
        document["evidence"].append({key: receipt[key] for key in ("gate", "sourceRevision", "runUrl", "result")})
    validate(document, previous)
    return document
