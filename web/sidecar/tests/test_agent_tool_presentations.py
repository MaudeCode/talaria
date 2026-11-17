"""TAL-2322: every tool a supported Agent registers has a Talaria presentation (``TOOL_PRESENTATIONS``), and the table
lists no tool the newest supported Agent dropped."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent

FIXTURE = Path(__file__).resolve().parents[3] / 'contracts/fixtures/tool-presentations.json'

# Tools only an older supported release registers, by release. They stay in the table while that release is supported.
OLDER_RELEASE_TOOLS = {
    'v0.23.0': {'yb_query_group_info', 'yb_query_group_members', 'yb_search_sticker', 'yb_send_dm', 'yb_send_sticker'},
}

PROBE = 'import json, model_tools\nfrom tools.registry import registry\nprint(json.dumps(sorted(registry.get_all_tool_names())))'


def supported_releases() -> list[dict]:
    return json.loads((SIDECAR_ROOT / 'agent_support.json').read_text())['releases']


def coverage_errors(registered: set[str], listed: set[str], *, newest: bool) -> list[str]:
    """A registered tool the table lacks; on the newest supported Agent, a listed tool no supported Agent registers."""
    errors = [f'Agent tool `{name}` has no Talaria presentation: add it to TOOL_PRESENTATIONS (generic until its view ships) '
              'and file a display ticket' for name in sorted(registered - listed)]
    if newest:
        older = set().union(*OLDER_RELEASE_TOOLS.values())
        errors += [f'TOOL_PRESENTATIONS lists `{name}`, which the newest supported Agent does not register: remove it, or list it '
                   'under the older supported release that still does in OLDER_RELEASE_TOOLS' for name in sorted(listed - registered - older)]
    return errors


def test_a_new_or_dropped_agent_tool_fails_with_its_fix() -> None:
    listed = {'terminal', 'read_file'}
    assert coverage_errors({'terminal', 'read_file', 'image_edit'}, listed, newest=False) == [
        'Agent tool `image_edit` has no Talaria presentation: add it to TOOL_PRESENTATIONS (generic until its view ships) '
        'and file a display ticket']
    # An older Agent may lack a newer tool; only the newest supported one makes an entry stale.
    assert coverage_errors({'terminal'}, listed, newest=False) == []
    assert coverage_errors({'terminal'}, listed, newest=True) == [
        'TOOL_PRESENTATIONS lists `read_file`, which the newest supported Agent does not register: remove it, or list it '
        'under the older supported release that still does in OLDER_RELEASE_TOOLS']
    # A tool an older supported release still registers stays listed.
    assert coverage_errors({'terminal'}, {'terminal', 'yb_send_dm'}, newest=True) == []


def test_older_release_tools_leave_with_their_release() -> None:
    supported = {release['releaseTag'] for release in supported_releases()}
    listed = set(json.loads(FIXTURE.read_text()))
    for tag, tools in OLDER_RELEASE_TOOLS.items():
        assert tag in supported, f'Agent {tag} left support: remove {sorted(tools)} from TOOL_PRESENTATIONS and OLDER_RELEASE_TOOLS'
        assert tools <= listed


@requires_agent
def test_every_registered_agent_tool_has_a_presentation(tmp_path) -> None:
    run = subprocess.run([AGENT_PYTHON, '-c', PROBE], cwd=AGENT_DIR, env=isolated_env(tmp_path / 'hermes'),
                         capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout + run.stderr
    registered = set(json.loads(run.stdout.strip().splitlines()[-1]))
    newest = max(supported_releases(), key=lambda release: tuple(int(part) for part in release['version'].split('.')))
    head = AGENT_DIR / '.git/HEAD'
    on_newest = head.is_file() and head.read_text().strip() == newest['sourceRevision']
    errors = coverage_errors(registered, set(json.loads(FIXTURE.read_text())), newest=on_newest)
    assert not errors, '\n'.join(errors)
