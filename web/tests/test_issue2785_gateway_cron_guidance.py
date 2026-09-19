"""Coverage for cron/gateway guidance in the Tasks panel and Docker docs."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = ROOT / "static" / "index.html"
PANELS_JS = ROOT / "static" / "panels.js"
DOCKER_DOC = ROOT / "docs" / "docker.md"


def test_docker_docs_explain_single_container_cron_gateway_boundary():
    docs = DOCKER_DOC.read_text(encoding="utf-8")

    assert "single-container setup runs the WebUI only" in docs
    assert "scheduled jobs require the Hermes gateway daemon" in docs
    assert "Gateway not configured" in docs
    assert "Gateway metadata stale" in docs
    assert "Gateway endpoint not reachable" in docs
    assert "`gateway_state.json` can become stale" in docs
    assert "HERMES_WEBUI_GATEWAY_BASE_URL" in docs
    assert "docker-compose.two-container.yml" in docs
