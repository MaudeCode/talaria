#!/usr/bin/env python3
"""Collect this run's named workflow artifacts without accepting overwrites."""

import argparse
from pathlib import Path

from cli import load, write


RECEIPT_DIRECTORIES = ("contract-receipts", "previous-app-receipts", "agent-receipts")
BUILD_RECEIPTS = ("app-build", "web-build", "relay-build", "app-publish", "web-publish", "relay-publish")
# The handoffs assembly reads: the plan (with its receipts and notes), receipts, and web-build's npm tarballs.
HANDOFFS = ("release-plan", *RECEIPT_DIRECTORIES, *BUILD_RECEIPTS)


def collect(source, destination):
    paths = []
    for bucket in ("release-plan/receipts", *RECEIPT_DIRECTORIES):
        paths.extend(sorted((source / bucket).glob("*.json")))
    for bucket in BUILD_RECEIPTS:
        path = source / bucket / "receipt.json"
        if path.is_file():
            paths.append(path)
    gates = {"mainCI", "signedTags", "currentContracts", "previousAppContracts", "agentCompatibility",
             "buildApp", "buildWeb", "buildRelay", "uploadApp", "publishWeb", "deployRelay"}
    for path in paths:
        value = load(path)
        if value.get("gate") not in gates:
            raise ValueError(f"unexpected receipt artifact: {path.name}")
        write(destination / (value["gate"] + ".json"), value)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    collect(args.source, args.destination)
