"""Select the Agent's bootstrap Python for both image build and source staging."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib
import urllib.error
import urllib.request


def python_request(source):
    lock = source / "pm/lock.json"
    if not lock.exists():
        # Pre-PM releases install their dependencies on the image's system Python.
        return sys.executable
    version = json.loads(lock.read_text()).get("packages", {}).get("python", {}).get("version")
    if version:
        # Match the Agent installer: 3.14.7+20260901 requests the 3.14 minor from uv.
        match = re.fullmatch(r"(3\.\d+)\.\d+(?:\+[A-Za-z0-9.]+)?", version)
        if not match:
            raise ValueError(f"Invalid Agent Python pin: {version!r}")
        return match[1]
    requires = tomllib.loads((source / "pyproject.toml").read_text())["project"]["requires-python"]
    # PM's compatibility floor admits old updaters; its exclusive minor ceiling names the runtime.
    ceiling = re.search(r"(?:^|,)\s*<\s*3\.(\d+)\s*(?:,|$)", requires)
    if not ceiling or int(ceiling[1]) < 2:
        raise ValueError(f"Cannot derive Agent Python from requires-python: {requires!r}")
    return f"3.{int(ceiling[1]) - 1}"


def install_pinned(pin):
    revision = json.loads(pin.read_text())["x-talaria"]["sourceRevision"]
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Agent sourceRevision must be an immutable commit SHA")
    with tempfile.TemporaryDirectory(prefix="agent-python-") as temporary:
        source = Path(temporary)
        for name in ("pm/lock.json", "pyproject.toml"):
            url = f"https://raw.githubusercontent.com/NousResearch/hermes-agent/{revision}/{name}"
            try:
                with urllib.request.urlopen(url, timeout=60) as response:
                    content = response.read()
            except urllib.error.HTTPError as error:
                if name == "pm/lock.json" and error.code == 404:
                    return  # Legacy source uses the system Python already installed in the image.
                raise
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        subprocess.run(["uv", "python", "install", "--no-bin", python_request(source)], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?")
    parser.add_argument("--install-pinned", type=Path, metavar="DEPENDENCY_JSON")
    args = parser.parse_args()
    if args.install_pinned and not args.source:
        install_pinned(args.install_pinned)
    elif args.source and not args.install_pinned:
        print(python_request(args.source))
    else:
        parser.error("pass a source directory or --install-pinned DEPENDENCY_JSON")
