"""Regression tests for frontend routing under subpath mounts like /hermes/."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_server_auth_redirect_uses_relative_login_path_with_encoded_next():
    src = read("api/auth.py")
    assert "handler.send_header('Location', 'login?next=' + _next)" in src
    assert "handler.send_header('Location', '/login?next='" not in src
    assert "safe='/'" in src, "the relative redirect must keep the existing next= encoding fix"
