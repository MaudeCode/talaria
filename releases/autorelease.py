"""One-step releases (TAL-336): turn one signed vX.Y.Z tag into the production-cutover request.

The root tag names the whole release. Each component whose sources changed since its released
source gets a namespaced tag at the same commit (`app-vX.Y.Z`, `web-vX.Y.Z`, `relay-vX.Y.Z`);
unchanged components reuse their previous tags. Deployed Web servers match `web-v<version>`, so
component tags keep their namespaces; the signed root tag authorizes them (validate_release_tag).
"""

import argparse
import json
import re
import subprocess
from pathlib import Path

from release_set import COMPONENTS

ROOT_TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
PATHS = {"app": "app/", "web": "web/", "relay": "relay/"}


def git(root, *args, check=True):
    return subprocess.run(["git", "-C", str(root), *args], text=True, capture_output=True, check=check).stdout.strip()


def request_for(root, tag, previous):
    """The cutover request and the components this release changes."""
    if not ROOT_TAG.fullmatch(tag):
        raise ValueError(f"release tag must be vX.Y.Z, got {tag}")
    if previous is None:
        raise ValueError("a one-step release needs the previous published release set")
    version = tag[1:]
    source = git(root, "rev-parse", f"refs/tags/{tag}^{{commit}}")
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


def ensure_component_tags(root, request, changed, release_tag):
    """Create the changed components' annotated tags at the release source; reuse one already there."""
    created = []
    for name in changed:
        tag, source = request["tags"][name], request["sourceRevision"]
        existing = git(root, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}", check=False)
        if existing:
            if existing != source:
                raise ValueError(f"{tag} already exists at {existing}; release a new version")
            continue
        git(root, "tag", "-a", "-m", f"Talaria {name.title()} {tag.rsplit('-v', 1)[1]}; release {release_tag}", tag, source)
        created.append(tag)
    # publish-set attaches the manifest to this tag. Create it now, while main still matches the source:
    # GITHUB_TOKEN may not create a ref whose workflows differ from main's, which failed v1.13.0 (TAL-421).
    root_tag = "release-set-" + request["sourceRevision"]
    if not git(root, "rev-parse", "--verify", "--quiet", f"refs/tags/{root_tag}", check=False):
        git(root, "tag", root_tag, request["sourceRevision"])
        created.append(root_tag)
    return created


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="The pushed root release tag, vX.Y.Z.")
    parser.add_argument("--previous", type=Path, required=True, help="The latest published release-set manifest.")
    parser.add_argument("--output", type=Path, required=True, help="Where to write the cutover request JSON.")
    parser.add_argument("--create-tags", action="store_true", help="Create the changed components' tags locally.")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    request, changed = request_for(root, args.tag, json.loads(args.previous.read_text()))
    created = ensure_component_tags(root, request, changed, args.tag) if args.create_tags else []
    args.output.write_text(json.dumps(request, sort_keys=True) + "\n")
    print(json.dumps({"request": request, "changed": changed, "created": created}))


if __name__ == "__main__":
    main()
