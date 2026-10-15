"""Named-provider origin isolation at the real RPC boundary, using loopback providers only."""
from __future__ import annotations

import json

import pytest

from conftest import OneToolCallModel, SidecarProcess, requires_agent, serve_model

TOKEN = "sk-synthetic-vendor-only"


class Capture(OneToolCallModel):
    seen: list[dict] = []

    def do_GET(self):
        self.seen.append({"metadata": True, "credential_present": self.headers.get("Authorization") == f"Bearer {TOKEN}"})
        super().do_GET()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        self.seen.append({"metadata": False, "credential_present": self.headers.get("Authorization") == f"Bearer {TOKEN}"})
        if self.path.startswith("/quota/"):
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"type": "insufficient_quota", "code": "insufficient_quota", "message": "Synthetic quota exhausted"}}).encode())
            return
        choice = {"index": 0, "finish_reason": "stop"}
        payload = {"id": "synthetic", "object": "chat.completion", "choices": [{**choice, "message": {"role": "assistant", "content": "Synthetic answer"}}]}
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            payload.update(object="chat.completion.chunk", choices=[{**choice, "delta": {"content": "Synthetic answer"}}])
            self.wfile.write(f"data: {json.dumps(payload)}\n\ndata: [DONE]\n\n".encode())
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())


def config(vendor: str, destination: str, route: str) -> dict:
    cfg = {"model": {"provider": "review-vendor", "default": "synthetic-model"},
           "providers": {"review-vendor": {"base_url": vendor, "models": ["synthetic-model"]}},
           "compression": {"enabled": False}, "agent": {"skip_memory": True}}
    override = {"provider": "review-vendor", "model": "synthetic-model", "base_url": destination}
    if route == "fallback":
        cfg["providers"]["primary"] = {"base_url": destination.replace("/v1", "/quota/v1"), "api_key": "sk-synthetic-primary"}
        cfg["model"]["provider"] = "primary"
        cfg["fallback_providers"] = [override]
    elif route == "auxiliary":
        cfg["auxiliary"] = {"title_generation": override}
    else:
        cfg["model"]["base_url"] = destination
    return cfg


def write_home(home, cfg):
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(json.dumps(cfg))
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}, "credential_pool": {
        "review-vendor": [{"id": "synthetic", "auth_type": "api_key", "priority": 0, "source": "manual", "access_token": TOKEN}]}}))


def call(proc, home, route, **overrides):
    if route == "auxiliary":
        return proc.call("aux.complete", {"profile_home": str(home), "task": "title_generation", "messages": [{"role": "user", "content": "Synthetic content only"}], "max_tokens": 32, **overrides})
    return proc.call("chat.start", {"profile_home": str(home), "session_id": "synthetic", "stream_id": "synthetic-stream", "user_message": "Synthetic content only", "workspace": str(home), "model": "synthetic-model", "model_provider": "primary" if route == "fallback" else "review-vendor", "enabled_toolsets": [], "max_iterations": 2, "max_tokens": 32, **overrides})


def assert_refused(reply, frames, seen):
    # Receipts retain only credential-present booleans, never credentials, endpoints or prompt text.
    assert not seen, f"provider requests escaped preflight: {seen}"
    assert reply.get("error", {}).get("data", {}).get("condition") == "inference_route_unsafe", reply
    assert not frames
    assert TOKEN not in json.dumps(reply)
    assert "127.0.0.1" not in json.dumps(reply)


@requires_agent
@pytest.mark.parametrize("route", ["fallback", "auxiliary"])
def test_cross_origin_named_routes_refused_before_metadata_or_content(hermes_home, route):
    Capture.seen = []
    with serve_model(Capture) as vendor, serve_model(Capture) as destination:
        write_home(hermes_home, config(vendor, destination, route))
        proc = SidecarProcess(hermes_home)
        try:
            reply, frames = call(proc, hermes_home, route)
            assert_refused(reply, frames, Capture.seen)
        finally:
            proc.close()


@requires_agent
@pytest.mark.parametrize("profile", ["main", "alpha", "beta"])
@pytest.mark.parametrize("route", ["primary", "auxiliary", "fallback"])
def test_same_origin_routes_complete_in_selected_profile(hermes_home, profile, route):
    Capture.seen = []
    with serve_model(Capture) as vendor:
        home = hermes_home if profile == "main" else hermes_home / "profiles" / profile
        write_home(home, config(vendor, vendor + "/same-origin", route))
        if profile != "main":
            write_home(hermes_home, config("not-a-url", "not-a-url", route))
        proc = SidecarProcess(hermes_home)
        try:
            reply, _ = call(proc, home, route)
            assert "error" not in reply, reply
            result = reply["result"]
            assert (result.get("text") or result.get("final_response")) == "Synthetic answer", result
            assert Capture.seen
            # Supported Agents before v0.22.2 do not rebind the named pool on fallback.
            if route != "fallback":
                assert any(row["credential_present"] for row in Capture.seen), Capture.seen
        finally:
            proc.close()


@requires_agent
@pytest.mark.parametrize("profile", ["main", "alpha", "beta"])
def test_route_policy_and_recovery_are_profile_scoped(hermes_home, profile):
    Capture.seen = []
    with serve_model(Capture) as vendor, serve_model(Capture) as destination:
        home = hermes_home if profile == "main" else hermes_home / "profiles" / profile
        cfg = config(vendor, destination, "auxiliary")
        write_home(home, cfg)
        proc = SidecarProcess(hermes_home)
        try:
            methods = {
                "chat.start": {"model_provider": "review-vendor"},
                "chat.compress": {}, "chat.refine": {}, "chat.commit_memory": {},
                "goals.evaluate": {},
                "aux.complete": {"task": "title_generation", "messages": [{"role": "user", "content": "Synthetic"}]},
                "aux.resolve": {"task": "title_generation"},
                "providers.resolve_runtime": {"requested": "review-vendor"},
                "models.context_length": {"provider": "review-vendor", "model": "synthetic-model"},
            }
            for method, params in methods.items():
                reply, frames = proc.call(method, {"profile_home": str(home), **params})
                assert_refused(reply, frames, Capture.seen)
            # An unrelated valid profile remains usable in the very same process.
            other = hermes_home / "profiles" / ("beta" if profile != "beta" else "alpha")
            write_home(other, config(vendor, vendor, "auxiliary"))
            reply, _ = call(proc, other, "auxiliary")
            assert reply.get("result", {}).get("text") == "Synthetic answer", reply
            before = len(Capture.seen)
            got = proc.result("config.get", {"profile_home": str(home)})
            assert got["config"]["auxiliary"]["title_generation"]["base_url"] == destination
            assert proc.result("runtime.status")["compatible"] is True
            cfg["auxiliary"]["title_generation"]["base_url"] = vendor
            proc.result("config.set", {"profile_home": str(home), "config": cfg})
            reply, _ = call(proc, home, "auxiliary")
            assert reply.get("result", {}).get("text") == "Synthetic answer", reply
            assert len(Capture.seen) > before
        finally:
            proc.close()


@requires_agent
def test_all_route_sources_and_request_overrides_fail_closed(hermes_home):
    Capture.seen = []
    with serve_model(Capture) as vendor, serve_model(Capture) as destination:
        proc = SidecarProcess(hermes_home)
        try:
            base = config(vendor, vendor, "auxiliary")
            cases = []
            for field in ("fallback_model", "fallback_providers"):
                cfg = json.loads(json.dumps(base))
                cfg[field] = [{"provider": "custom:review-vendor", "model": "m", "base_url": destination, "api_key": "sk-synthetic-override"}]
                cases.append((cfg, {}))
            cfg = json.loads(json.dumps(base))
            cfg["auxiliary"]["title_generation"]["fallback_chain"] = [{"provider": "review-vendor", "model": "m", "base_url": destination}]
            cases.append((cfg, {}))
            cfg = json.loads(json.dumps(base))
            cfg["model"]["base_url"] = destination
            cases.append((cfg, {}))
            cfg = json.loads(json.dumps(base))
            cfg["custom_providers"] = [{"name": "Legacy Vendor", "base_url": vendor}]
            cfg["auxiliary"]["title_generation"].update(provider="custom:legacy-vendor", base_url=destination)
            cases.append((cfg, {}))
            for endpoint in ("${env:MISSING_ENDPOINT}", "https://", "ftp://example.invalid", "https://user:secret@example.invalid", "https://example.invalid:bad", None):
                cfg = json.loads(json.dumps(base))
                cfg["providers"]["review-vendor"]["base_url"] = endpoint
                cases.append((cfg, {}))
            for override in ({"main_runtime": {"provider": "review-vendor", "base_url": destination, "api_key": "sk-synthetic-override"}},
                             {"main_runtime": {"provider": "custom", "requested_provider": "review-vendor", "base_url": destination}},
                             {"main_runtime": {"provider": "review-vendor", "requested_provider": "custom", "base_url": destination}},
                             {"provider": "review-vendor", "base_url": destination, "api_key": "sk-synthetic-override"}):
                cases.append((base, override))
            for cfg, overrides in cases:
                write_home(hermes_home, cfg)
                reply, frames = call(proc, hermes_home, "auxiliary", **overrides)
                assert_refused(reply, frames, Capture.seen)
            # Runtime and metadata bridges must check their own explicit endpoint overrides.
            write_home(hermes_home, base)
            for method, params in (("providers.resolve_runtime", {"requested": "review-vendor"}), ("models.context_length", {"provider": "review-vendor", "model": "m"})):
                reply, frames = proc.call(method, {"profile_home": str(hermes_home), "base_url": destination, "api_key": "sk-synthetic-override", **params})
                assert_refused(reply, frames, Capture.seen)
            (hermes_home / "config.yaml").write_text("model: [invalid: yaml")
            reply, frames = call(proc, hermes_home, "auxiliary")
            assert_refused(reply, frames, Capture.seen)
            (hermes_home / "config.yaml").unlink()
            reply, frames = proc.call("providers.resolve_runtime", {"profile_home": str(hermes_home), "requested": "custom:missing", "base_url": destination})
            assert_refused(reply, frames, Capture.seen)
        finally:
            proc.close()


def test_origins_use_scheme_host_and_effective_port():
    from talaria_sidecar.inference_routes import _origin
    from talaria_sidecar.errors import RpcError

    assert _origin("HTTPS://EXAMPLE.invalid/a") == _origin("https://example.invalid:443/b")
    assert _origin("http://[::1]/a") == _origin("http://[::1]:80/b")
    assert _origin("http://example.invalid") != _origin("https://example.invalid")
    assert _origin("https://example.invalid:444") != _origin("https://example.invalid")
    for value in ("", None, "https://example.invalid:", "https://example.invalid:0", "https://example.invalid\\@evil.invalid", "https://ex ample.invalid", "https://${env:UNSET}/v1"):
        with pytest.raises(RpcError):
            _origin(value)


@requires_agent
def test_environment_endpoints_and_anonymous_recovery(hermes_home):
    Capture.seen = []
    with serve_model(Capture) as vendor, serve_model(Capture) as destination:
        alpha = hermes_home / "profiles" / "alpha"
        beta = hermes_home / "profiles" / "beta"
        for home, endpoint in ((hermes_home, destination), (alpha, vendor), (beta, vendor)):
            cfg = config("${env:VENDOR_ENDPOINT}", "${VENDOR_ENDPOINT}/path", "auxiliary")
            write_home(home, cfg)
            (home / ".env").write_text(f"VENDOR_ENDPOINT={endpoint}\n")
        proc = SidecarProcess(hermes_home)
        try:
            for home in (alpha, beta, hermes_home):
                reply, _ = call(proc, home, "auxiliary")
                assert reply.get("result", {}).get("text") == "Synthetic answer", reply
            # Losing the selected profile's reference cannot borrow the launch profile's value.
            (alpha / ".env").write_text("")
            Capture.seen = []
            reply, frames = call(proc, alpha, "auxiliary")
            assert_refused(reply, frames, Capture.seen)
            # Anonymous custom with its own key is a supported repair path.
            cfg = config(vendor, destination, "auxiliary")
            cfg["auxiliary"]["title_generation"].update(provider="custom", api_key="sk-synthetic-destination-only")
            write_home(alpha, cfg)
            reply, _ = call(proc, alpha, "auxiliary")
            assert reply.get("result", {}).get("text") == "Synthetic answer", reply
            assert Capture.seen and not any(row["credential_present"] for row in Capture.seen)
        finally:
            proc.close()


@requires_agent
def test_cron_inference_uses_execution_profile_and_guards_job_overrides(hermes_home):
    Capture.seen = []
    with serve_model(Capture) as vendor, serve_model(Capture) as destination:
        execution = hermes_home / "profiles" / "execution"
        write_home(hermes_home, config(vendor, vendor, "auxiliary"))
        bad = config(vendor, destination, "auxiliary")
        write_home(execution, bad)
        proc = SidecarProcess(hermes_home)
        try:
            reply, frames = proc.call("cron.create", {"profile_home": str(hermes_home), "execution_home": str(execution),
                                                      "job": {"profile": "execution", "schedule": "every 1h", "prompt": "Synthetic"}})
            assert_refused(reply, frames, Capture.seen)
            job = proc.result("cron.create", {"profile_home": str(hermes_home), "job": {
                "schedule": "every 1h", "prompt": "Synthetic", "provider": "review-vendor", "model": "synthetic-model"}})["job"]
            reply, frames = proc.call("cron.run", {"profile_home": str(hermes_home), "execution_home": str(execution), "job_id": job["id"]})
            assert_refused(reply, frames, Capture.seen)
            write_home(execution, config(vendor, vendor, "auxiliary"))
            store = hermes_home / "cron" / "jobs.json"
            saved = json.loads(store.read_text())
            saved["jobs"][0]["base_url"] = destination
            store.write_text(json.dumps(saved))
            reply, frames = proc.call("cron.run", {"profile_home": str(hermes_home), "execution_home": str(execution), "job_id": job["id"]})
            assert_refused(reply, frames, Capture.seen)
            write_home(execution, bad)
            # Plugin inference is guarded too; local repair commands stay available.
            reply, frames = proc.call("commands.exec", {"profile_home": str(execution), "command": "/synthetic-plugin"})
            assert_refused(reply, frames, Capture.seen)
            assert proc.result("cron.get", {"profile_home": str(hermes_home), "job_id": job["id"]})["job"]["id"] == job["id"]
        finally:
            proc.close()
