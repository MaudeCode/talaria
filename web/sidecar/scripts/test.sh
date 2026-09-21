#!/usr/bin/env bash
# Run the sidecar pytest suite. pytest runs on any Python >= 3.11 (a private
# venv under sidecar/.venv); the sidecar itself is spawned on the pinned
# Agent's venv interpreter discovered by tests/conftest.py.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="${HERMES_WEBUI_TEST_PYTHON:-python3}"
venv="$here/.venv"
if [[ ! -x "$venv/bin/python" ]]; then
  "$runner" -m venv "$venv"
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check "pytest>=8,<10"
fi
state="${TMPDIR:-/tmp}/talaria-sidecar-tests.$$"
mkdir -p "$state"
trap 'rm -rf -- "$state"' EXIT
cd "$here"
# GitHub's relocated Linux Python needs LD_LIBRARY_PATH; nothing else from the caller's environment leaks in.
env -i PATH="$PATH" HOME="$state" TMPDIR="$state" ${LD_LIBRARY_PATH:+LD_LIBRARY_PATH="$LD_LIBRARY_PATH"} \
  HERMES_WEBUI_AGENT_DIR="${HERMES_WEBUI_AGENT_DIR:-$HOME/.hermes/hermes-agent}" \
  HERMES_WEBUI_PYTHON="${HERMES_WEBUI_PYTHON:-}" \
  PYTHONPATH="$here" \
  "$venv/bin/python" -m pytest -q "$@"
