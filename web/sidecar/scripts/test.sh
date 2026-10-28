#!/usr/bin/env bash
# Run the shared fast/process/compatibility suite. Fast and synthetic process
# layers need only pytest; compatibility uses the selected Agent interpreter.
# Without an Agent checkout, the existing checker provisions the active pin.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="${HERMES_WEBUI_TEST_PYTHON:-python3}"
if [[ -z "${HERMES_WEBUI_AGENT_DIR:-}" && "$("$runner" "$here/scripts/suite_runner.py" --requires-agent "$@")" == true ]]; then
  exec "$runner" "$here/../../scripts/check-agent-compatibility.py" --skip-docker --skip-sidecar-tests \
    --command "$here/scripts/test.sh" "$@"
fi
venv="$here/.venv"
if [[ ! -x "$venv/bin/python" ]]; then
  "$runner" -m venv "$venv"
  # pytest 9.2 renames parametrized case ids, which the reviewed inventory in tests/process_inventory.json lists.
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check "pytest>=8,<9.2"
fi
state="${TMPDIR:-/tmp}/talaria-sidecar-tests.$$"
mkdir -p "$state"
trap 'rm -rf -- "$state"' EXIT
cd "$here"
# GitHub's relocated Linux Python needs LD_LIBRARY_PATH; nothing else from the caller's environment leaks in.
env -i PATH="$PATH" HOME="$state" TMPDIR="$state" ${LD_LIBRARY_PATH:+LD_LIBRARY_PATH="$LD_LIBRARY_PATH"} \
  HERMES_WEBUI_IMPORTER_DIR="${HERMES_WEBUI_IMPORTER_DIR:-}" \
  HERMES_WEBUI_AGENT_DIR="${HERMES_WEBUI_AGENT_DIR:-}" \
  HERMES_WEBUI_PYTHON="${HERMES_WEBUI_PYTHON:-}" \
  ${TALARIA_SIDECAR_WORKERS+TALARIA_SIDECAR_WORKERS="$TALARIA_SIDECAR_WORKERS"} \
  ${TALARIA_SIDECAR_TOTAL_WORKERS:+TALARIA_SIDECAR_TOTAL_WORKERS="$TALARIA_SIDECAR_TOTAL_WORKERS"} \
  PYTHONPATH="$here" \
  "$venv/bin/python" "$here/scripts/suite_runner.py" "$@"
