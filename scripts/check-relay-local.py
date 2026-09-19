#!/usr/bin/env python3
"""Validate Convex in an anonymous local deployment with a disposable HOME."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent


def main():
    node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="talaria-convex-") as temporary:
        trial = Path(temporary)
        project = trial / "relay"
        project.mkdir()
        for name in ("package.json", "pnpm-lock.yaml", "tsconfig.json"):
            shutil.copy2(ROOT / "relay" / name, project / name)
        shutil.copytree(ROOT / "relay/convex", project / "convex")
        (project / "node_modules").symlink_to(ROOT / "relay/node_modules", target_is_directory=True)
        (trial / "home").mkdir()
        env = {"PATH": str(Path(node).parent) + os.pathsep + os.environ["PATH"],
               "HOME": str(trial / "home"), "CONVEX_AGENT_MODE": "anonymous",
               "CONVEX_DISABLE_TELEMETRY": "1"}
        # The CLI owns and terminates its local backend on exit, including errors.
        subprocess.run([
            node, str(ROOT / "relay/node_modules/convex/bin/main.js"), "dev", "--once",
            "--typecheck", "enable", "--tail-logs", "disable",
        ], cwd=project, env=env, check=True)
    print("PASS isolated local Convex validation")


if __name__ == "__main__":
    main()
