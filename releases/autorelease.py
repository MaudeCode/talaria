"""Tag-last releases (TAL-2342): turn the dispatched version and commit into the release request.

The release is a dispatch of production-cutover.yml with `tag` (vX.Y.Z) and `sha`. Each component whose sources
changed since its released source is planned under a namespaced version at that commit (`app-vX.Y.Z`, `web-vX.Y.Z`,
`relay-vX.Y.Z`); unchanged components reuse their previous tags. No tag is created here: the release's last job
creates the changed components' tags and then the root tag, once everything published.
"""

import argparse
import json
import subprocess
from pathlib import Path

from plan import ROOT_TAG, SHA
from release_set import COMPONENTS

PATHS = {"app": "app/", "web": "web/", "relay": "relay/"}


def request_for(root, tag, source, previous):
    """The cutover request and the components this release changes."""
    if not ROOT_TAG.fullmatch(tag):
        raise ValueError(f"release tag must be vX.Y.Z, got {tag}")
    if not SHA.fullmatch(source):
        raise ValueError("release source must be a full commit SHA")
    if previous is None:
        raise ValueError("a release needs the previous published release set")
    version = tag[1:]
    tags, changed = {}, []
    for name in COMPONENTS:
        prior = previous["components"][name]
        unchanged = subprocess.run(["git", "-C", str(root), "diff", "--quiet", prior["sourceRevision"], source,
                                    "--", PATHS[name]]).returncode == 0
        if unchanged:
            tags[name] = prior["tag"]
        else:
            tags[name] = f"{name}-v{version}"
            changed.append(name)
    if not changed:
        raise ValueError(f"nothing changed since release set {previous['releaseSet']}")
    return {"sourceRevision": source, "tags": tags, "relayDeploymentId": previous["components"]["relay"]["deploymentId"]}, changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="The version to release, vX.Y.Z.")
    parser.add_argument("--sha", required=True, help="The full commit SHA to release.")
    parser.add_argument("--previous", type=Path, required=True, help="The latest published release-set manifest.")
    parser.add_argument("--output", type=Path, required=True, help="Where to write the cutover request JSON.")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    request, changed = request_for(root, args.tag, args.sha, json.loads(args.previous.read_text()))
    args.output.write_text(json.dumps(request, sort_keys=True) + "\n")
    print(json.dumps({"request": request, "changed": changed}))


if __name__ == "__main__":
    main()
