#!/usr/bin/env python3
"""Validate release receipts; never turn an unverified plan into a release.

The trusted workflow supplies receipts after its gates pass. This module checks
their consistency, not the authenticity of arbitrary JSON supplied by a caller.
"""

import argparse
import json
from pathlib import Path

from jsonschema import Draft202012Validator, ValidationError


SCHEMA = json.loads(Path(__file__).with_name("release-set.schema.json").read_text())
Draft202012Validator.check_schema(SCHEMA)
VALIDATOR = Draft202012Validator(SCHEMA)
COMPONENTS = ("app", "web", "relay")
COMMON_GATES = {"signedTags", "mainCI", "currentContracts", "previousAppContracts", "agentCompatibility"}
PUBLISH_GATES = {"app": "uploadApp", "web": "publishWeb", "relay": "deployRelay"}


def require_version_advance(tag, prior_tag):
    channel, version = tag.rsplit("-v", 1)
    prior_channel, prior_version = prior_tag.rsplit("-v", 1)
    if channel == prior_channel and tuple(map(int, version.split("."))) <= tuple(map(int, prior_version.split("."))):
        raise ValueError(f"{tag} must advance the published version {prior_tag}")


def require_compatible_contracts(contracts, previous=None):
    for contract, peers in contracts.items():
        if not set.intersection(*(set(versions) for versions in peers.values())):
            raise ValueError(f"incompatible {contract} capabilities")
    if previous:
        for contract, client, server in (("appWeb", "app", "web"), ("appRelay", "app", "relay"),
                                         ("activityScene", "app", "relay"), ("webRelay", "web", "relay"),
                                         ("appWeb", "web", "app")):
            if not set(previous["contracts"][contract][client]) & set(contracts[contract][server]):
                raise ValueError(f"previous {client.title()} is incompatible with {contract}")


def validate(document, previous=None):
    """Reject mutable references, incomplete receipts and incompatible peers."""
    VALIDATOR.validate(document)
    if previous is not None:
        # A predecessor can itself have a predecessor. Its chain is authenticated
        # when downloaded by the workflow, rather than recursively embedded here.
        VALIDATOR.validate(previous)
        if previous["status"] != "complete":
            raise ValueError("previous release set must be complete")
        if document["previousReleaseSet"] != previous["releaseSet"]:
            raise ValueError("previous release set does not match")
        if document["releaseSet"] == previous["releaseSet"]:
            raise ValueError("a completed release set is immutable")
    elif document["previousReleaseSet"] is not None:
        raise ValueError("previous release manifest is required")

    changed = []
    for name, component in document["components"].items():
        if component["tag"].split("-v")[-1] != component["version"]:
            raise ValueError(f"{name} tag/version mismatch")
        if component["releaseSet"] != component["sourceRevision"]:
            raise ValueError(f"{name} release set must identify its source commit")
        prior = previous["components"][name] if previous else None
        if component == prior:
            for contract, peers in document["contracts"].items():
                if name in peers and peers[name] != previous["contracts"][contract][name]:
                    raise ValueError(f"reused {name} cannot change advertised contracts")
            if name == "web" and document["agent"] != previous["agent"]:
                raise ValueError("reused Web cannot change its compatible Agent identity")
            continue
        if prior and component["tag"] == prior["tag"]:
            raise ValueError(f"{name} cannot mutate an existing component tag")
        if prior:
            require_version_advance(component["tag"], prior["tag"])
        if component["sourceRevision"] != document["releaseSet"]:
            raise ValueError(f"changed {name} must use the release-set commit")
        changed.append(name)
    if not changed:
        raise ValueError("a release set must change at least one component")

    require_compatible_contracts(document["contracts"], previous)

    gates = {}
    for receipt in document["evidence"]:
        gate = receipt["gate"]
        if gate in gates or receipt["sourceRevision"] != document["releaseSet"]:
            raise ValueError(f"duplicate or wrong-source evidence for {gate}")
        gates[gate] = receipt
    required = COMMON_GATES | {f"build{name.title()}" for name in changed}
    relay = document["components"]["relay"]
    if document["status"] == "complete":
        required |= {PUBLISH_GATES[name] for name in changed}
        if relay["deployedRevision"] != relay["sourceRevision"]:
            raise ValueError("completed Relay must identify the deployed source revision")
    else:
        if set(gates) & set(PUBLISH_GATES.values()):
            raise ValueError("dry-run candidates cannot contain publication evidence")
        if "relay" in changed and relay["deployedRevision"] is not None:
            raise ValueError("dry-run candidate cannot claim a new Relay deployment")
    if missing := required - gates.keys():
        raise ValueError(f"missing successful gates: {', '.join(sorted(missing))}")
    if set(gates) & set(PUBLISH_GATES.values()) - required:
        raise ValueError("unchanged components cannot be republished")
    combined = "\n\n".join(f"## {name.title()}\n\n{document['notes'][name].strip()}" for name in COMPONENTS)
    if document["notes"]["combined"] != combined:
        raise ValueError("combined notes must contain the exact component notes")
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--output", type=Path, help="Write validated JSON; refuse to overwrite an existing manifest.")
    args = parser.parse_args()
    try:
        document = json.loads(args.manifest.read_text())
        previous = json.loads(args.previous.read_text()) if args.previous else None
        changed = validate(document, previous)
        if args.output:
            with args.output.open("x") as stream:
                stream.write(json.dumps(document, indent=2) + "\n")
    except (ValueError, OSError, ValidationError) as error:
        parser.exit(1, f"release set rejected: {error}\n")
    print(f"Validated {document['status']} {document['releaseSet']}: {', '.join(changed)} changed")


if __name__ == "__main__":
    main()
