#!/usr/bin/env python3
"""Record real sidecar responses as contract fixtures.

Runs tests/scenarios.py against the pinned Agent and writes
packages/contracts/fixtures/sidecar/<namespace>.json with temporary paths
normalized to ``<home>`` / ``<profile>``. The Vitest fixture test validates
every recorded pair against the Zod schemas, and FakeSidecar answers from them.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "tests"))

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess  # noqa: E402
from talaria_sidecar import SIDECAR_RPC_VERSION  # noqa: E402
from test_namespaces import run_scenarios  # noqa: E402

TARGET = HERE.parent / "packages" / "contracts" / "fixtures" / "sidecar"


def normalize(value, substitutions):
    if isinstance(value, str):
        for real, placeholder in substitutions:
            value = value.replace(real, placeholder)
        return value
    if isinstance(value, dict):
        return {k: normalize(v, substitutions) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v, substitutions) for v in value]
    return value


def main() -> int:
    if AGENT_DIR is None or AGENT_PYTHON is None:
        print("pinned Agent checkout with venv not found", file=sys.stderr)
        return 2
    root = pathlib.Path(tempfile.mkdtemp(prefix="talaria-fixtures-")) / "home" / ".hermes"
    root.mkdir(parents=True)
    proc = SidecarProcess(root)
    fixtures: dict[str, dict[str, list]] = {}
    try:
        handshake = proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
        subs = [(str(root / "profiles" / "alpha"), "<profile>"), (str(root), "<home>"), (str(root.parent), "<user-home>"), (str(AGENT_DIR), "<agent>"), (AGENT_PYTHON, "<python>")]
        fixtures.setdefault("runtime", {})["runtime.handshake"] = [{"params": {"rpc_version": SIDECAR_RPC_VERSION}, "result": normalize(handshake, subs)}]
        for method, params, message, frames in run_scenarios(proc, root):
            if "error" in message:
                raise SystemExit(f"{method} failed: {message['error']}")
            namespace = method.split(".", 1)[0]
            entry = {"params": normalize(params, subs), "result": normalize(message["result"], subs)}
            if frames:
                entry["stream"] = [{"event": f["event"], "data": normalize(f["data"], subs)} for f in frames]
            fixtures.setdefault(namespace, {}).setdefault(method, []).append(entry)
    finally:
        proc.close()
    TARGET.mkdir(parents=True, exist_ok=True)
    for stale in TARGET.glob("*.json"):
        stale.unlink()
    for namespace, methods in sorted(fixtures.items()):
        (TARGET / f"{namespace}.json").write_text(json.dumps(methods, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"record-fixtures: wrote {sum(len(v) for v in fixtures.values())} methods across {len(fixtures)} namespaces to {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
