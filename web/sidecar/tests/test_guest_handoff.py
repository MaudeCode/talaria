"""Standalone native retry ownership over retained and newly-created auth debt."""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION


@requires_agent
def test_standalone_resumes_native_guest_handoffs(tmp_path):
    if not (AGENT_DIR / "hermes_cli/guest_handoff.py").is_file():
        pytest.skip("Agent predates native guest handoff")
    probe = Path(__file__).with_name("probe_guest_handoff.py")
    epoch = str(time.time())
    for scenario in ("retained", "plain_device", "wrong_account", "deleted_profile", "eof_retained"):
        case = tmp_path / scenario
        launch, owner, shared = case / "launch", case / "profiles/owner", case / "shared"
        for home in (launch, owner, shared):
            home.mkdir(parents=True)
        for home in (launch, owner):
            (home / "config.yaml").write_text("model:\n  default: fixture-model\nnous:\n  keepalive_interval_seconds: 0\n")
        guest = {"auth_method": "anonymous", "anon_token": "anon_fixture",
                 "portal_base_url": "https://portal.example.invalid",
                 "access_token": "eyJhbGciOiJub25lIn0.eyJzdWIiOiJndWVzdF9maXh0dXJlIiwiY2xpZW50X2lkIjoibmFzLWFub255bW91cyIsImFjY291bnRfdGllciI6ImFub255bW91cyJ9.sig"}
        (shared / "nous_auth.json").write_text(json.dumps({"_schema": 1, **guest}))
        env = {"HERMES_SHARED_AUTH_DIR": str(shared), "HANDOFF_EPOCH": epoch,
               "HANDOFF_TRANSIENT": "1",
               "HERMES_PORTAL_BASE_URL": "https://portal.example.invalid",
               "HERMES_ANON_API_SECRET": "synthetic_secret"}
        if scenario != "plain_device":
            (owner / "auth.json").write_text(json.dumps({"version": 1, "providers": {"nous": guest}}))
            seeded = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR), "seed"],
                env=isolated_env(owner, **env), capture_output=True, text=True, timeout=40)
            assert seeded.returncode == 0, seeded.stdout + seeded.stderr
            record = json.loads(seeded.stdout)["records"][0]
            assert record["state"] == "retrying" and record["attempts"] == 1
            env["HANDOFF_TRANSIENT"] = "0"
        if scenario == "deleted_profile":
            shutil.rmtree(owner)
        if scenario == "wrong_account":
            def segment(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
            wrong = ".".join([segment({"alg": "none"}), segment({"sub": "another_account", "exp": int(time.time()) + 86400}), "sig"])
            (owner / "auth.json").write_text(json.dumps({"version": 1, "providers": {"nous": {"access_token": wrong}}}))
        process_home = owner if scenario == "plain_device" else launch
        peer = SidecarProcess(process_home, env=env,
            command=[AGENT_PYTHON, str(probe), str(AGENT_DIR), "serve"])
        try:
            result = peer.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
            assert result["compatible"], result
            if scenario == "plain_device":
                flow = peer.result("oauth.start", {"profile_home": str(owner), "provider": "nous"})
                ended = peer.result("probe.flow_join", {"flow_id": flow["flow_id"]})
                assert ended["status"] == "approved", ended
                assert ended["nous_account"]["state"] == "retrying"
                assert ended["nous_account"]["email"] == "f***@example.invalid"
                assert peer.result("probe.inspect")["claims"] == 1
                for _ in range(2):
                    assert peer.result("oauth.poll", {"profile_home": str(owner), "flow_id": flow["flow_id"]})["status"] == "approved"
                assert peer.result("probe.inspect")["claims"] == 1, "poll dispatched a claim"
            if scenario == "eof_retained":
                assert peer.result("probe.inspect")["records"][0]["attempts"] == 1
                continue
            observed = peer.result("probe.tick")
            record = observed["records"][0]
            if scenario in ("wrong_account", "deleted_profile", "eof_retained"):
                assert observed["claims"] == 0 and record["state"] == "retrying"
                assert record["attempts"] == 1 and record["credential_retained"]
                if scenario == "wrong_account":
                    result = peer.result("providers.nous_account", {"profile_home": str(owner)})["nous_account"]
                    assert result["state"] == "paused" and result["moved"] == [] and result["reconnect"] == []
            else:
                assert record["state"] == "claimed", "standalone sidecar left a due retained connector handoff unserviced"
                assert record["attempts"] == 2 and not record["credential_retained"]
                assert record["moved"] == ["calendar"]
                result = peer.result("providers.nous_account", {"profile_home": str(owner)})["nous_account"]
                assert result["state"] == "claimed" and result["moved"] == ["calendar"]
                assert "calendar" in " ".join(result["lines"])
                assert result["dropped"] == ["gmail"] and result["reconnect"] == ["gmail"]
                assert "fixture@example.invalid" not in json.dumps(result)
                assert "anon_fixture" not in json.dumps(result) and "access_token" not in json.dumps(result)
            peer.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
            assert peer.result("probe.native_start", {"construct": scenario == "retained"})["worker_alive"]
            peer.result("runtime.shutdown")
        finally:
            assert peer.close() == 0, peer.stderr_lines[-10:]
            if scenario == "eof_retained":
                record = next(iter(json.loads((shared / "guest_handoff.json").read_text())["records"].values()))
                assert record["state"] == "retrying" and record["attempts"] == 1
                assert record["anon_token"] == "anon_fixture"
