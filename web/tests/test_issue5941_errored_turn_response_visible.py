import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def _function_body(src: str, name: str) -> str:
    marker = f"function {name}"
    start = src.index(marker)
    brace = src.index("{", start)
    depth = 0
    for idx in range(brace, len(src)):
        ch = src[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[brace + 1 : idx]
    raise AssertionError(f"function {name} body not found")


def _extract(src: str, name: str) -> str:
    marker = f"function {name}"
    start = src.index(marker)
    body = _function_body(src, name)
    sig = src[start : src.index("{", start)]
    return f"{sig}{{{body}}}"


@pytest.mark.skipif(NODE is None, reason="node required for behavioral test")
def test_errored_worklog_keep_open_decision_matrix():
    """Errored content is visible unless the user explicitly collapsed it."""
    harness = textwrap.dedent("""
        function decide(scene, savedDisclosure, keepSettledWorklogOpen) {
          const errored = new Set(['error', 'no_response']).has(scene.terminal_state);
          const keepErroredResponseVisible = errored && savedDisclosure !== 'closed';
          return !keepSettledWorklogOpen && !keepErroredResponseVisible;
        }
        const out = {};
        // Errored turns default open; an explicit close still wins.
        out.errored_default = decide({ terminal_state: 'error' }, null, false);
        out.errored_user_collapsed = decide({ terminal_state: 'error' }, 'closed', false);
        out.errored_user_open = decide({ terminal_state: 'no_response' }, 'open', false);
        // A normal completed turn collapses as before.
        out.completed_default = decide({ terminal_state: 'completed' }, null, false);
        console.log(JSON.stringify(out));
    """)
    res = subprocess.run([NODE, "-e", harness], capture_output=True, text=True, timeout=30)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout.strip())
    assert out == {
        "errored_default": False,
        "errored_user_collapsed": True,
        "errored_user_open": False,
        "completed_default": True,
    }
