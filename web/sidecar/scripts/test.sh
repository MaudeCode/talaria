#!/usr/bin/env bash
# Run the sidecar pytest suite. pytest runs on any Python >= 3.11 (a private
# venv under sidecar/.venv); the sidecar itself is spawned on the Agent venv in
# HERMES_WEBUI_AGENT_DIR, else on the active pinned release: the script re-runs
# itself under scripts/check-agent-compatibility.py, which provisions that
# release once into a shared cache and holds it for the whole run.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="${HERMES_WEBUI_TEST_PYTHON:-python3}"
if [[ -z "${HERMES_WEBUI_AGENT_DIR:-}" ]]; then
  exec "$runner" "$here/../../scripts/check-agent-compatibility.py" --skip-docker --skip-sidecar-tests \
    --command "$here/scripts/test.sh" "$@"
fi
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
  HERMES_WEBUI_AGENT_DIR="$HERMES_WEBUI_AGENT_DIR" \
  HERMES_WEBUI_PYTHON="${HERMES_WEBUI_PYTHON:-}" \
  ${TALARIA_SIDECAR_WORKERS+TALARIA_SIDECAR_WORKERS="$TALARIA_SIDECAR_WORKERS"} \
  ${TALARIA_SIDECAR_TOTAL_WORKERS:+TALARIA_SIDECAR_TOTAL_WORKERS="$TALARIA_SIDECAR_TOTAL_WORKERS"} \
  PYTHONPATH="$here" \
  "$venv/bin/python" "$here/scripts/suite_runner.py" "$@"
