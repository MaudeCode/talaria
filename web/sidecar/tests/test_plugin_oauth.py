"""TAL-1276: sign in to, check and sign out of a plugin-declared OAuth client from Web, on the real Agent."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent


def _probe(tmp_path: Path) -> dict:
    home = tmp_path / ".hermes"
    home.mkdir()
    probe = Path(__file__).with_name("plugin_oauth_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=isolated_env(home, TMPDIR=str(tmp_path)), capture_output=True, text=True, timeout=180)
    assert run.returncode == 0, run.stderr[-4000:]
    return json.loads(run.stdout.strip().splitlines()[-1])


def test_plugin_oauth_sign_in_status_and_sign_out(tmp_path: Path) -> None:
    out = _probe(tmp_path)
    if out["before"] == {"supported": False, "clients": None}:
        # Agents before v0.22.3 declare no plugin OAuth clients: no status and no sign-in, nothing partial.
        assert out == {"before": {"supported": False, "clients": None}, "start": "oauth_unsupported"}
        return
    synthetic = {"id": "synthetic", "authorize_host": "127.0.0.1", "token_host": "127.0.0.1"}
    assert out == {
        "before": {"supported": True, "clients": [{**synthetic, "state": "logged_out"}]},
        "start_fields": ["authorize_host", "expires_in", "flow_id", "interval", "provider", "redirect_uri", "status", "token_host", "verification_url"],
        "start_hosts": ["127.0.0.1", "127.0.0.1"],
        "redirect_is_loopback": "127.0.0.1",
        "loopback": "approved",
        "loopback_grant": ["access_token", "expires_at_ms", "fingerprint", "last_refresh", "refresh_token"],
        "loopback_agent_status": "logged in",
        "loopback_state": [{**synthetic, "state": "signed_in"}],
        "logout": {"key": "oauth-probe", "id": "synthetic", "removed": True},
        "logout_grant": None,
        "logout_agent_status": "logged out",
        "logout_state": [{**synthetic, "state": "logged_out"}],
        "paste_submitted": "pending",
        "paste": "approved",
        "paste_agent_status": "logged in",
        "paste_state": ["signed_in"],
        "wrong_state": ["error", None],
        "foreign_host": ["oauth_redirect_invalid", "pending", None],
        "expired": ["expired", "oauth_flow_ended", None],
        "cancelled": ["cancelled", "oauth_flow_ended", "closed", "cancelled", None],
        "leaks": [],
        "link_has_verifier": False,
    }
