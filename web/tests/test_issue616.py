import pathlib


def test_workspace_suggest_endpoint_is_wired():
    src = pathlib.Path("api/routes.py").read_text(encoding="utf-8")
    assert '"/api/workspaces/suggest"' in src
