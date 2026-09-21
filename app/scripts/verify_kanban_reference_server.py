#!/usr/bin/env python3
"""Exercise the Kanban HTTP surface of the Talaria Web server against an isolated real DB.

This verifier intentionally:

- boots the built Node server on loopback with an ephemeral port and a password;
- stores all Hermes/Kanban state in a temporary directory;
- runs the Web Python sidecar on the pinned Hermes Agent checkout (``--agent-root``)
  so ``hermes_cli.kanban_db`` is the real implementation;
- calls Dispatcher only with ``dry_run=true``, which never spawns workers; and
- never touches ``~/.hermes`` or a model provider.

It prints aggregate evidence only. Task IDs, payload contents, local paths, and
configuration values are never emitted.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener


EXPECTED_AGENT_REVISION = "2ccfdb2db4eedf385f6c5b3fe722e183cee1b6de"


class VerificationError(RuntimeError):
    """A redaction-safe verification failure."""


def git_revision(root: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def require(condition: bool, label: str) -> None:
    if not condition:
        raise VerificationError(label)


def boot_server(agent_root: Path, webui_root: Path, state_root: Path, password: str) -> tuple[subprocess.Popen, int]:
    """Start the built Node server with disposable state; the caller terminates it."""
    require(git_revision(agent_root) == EXPECTED_AGENT_REVISION, "agent-revision")
    server_bin = webui_root / "packages/server/dist/bin/talaria-web.js"
    require(server_bin.is_file(), "server-bin")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    hermes_home = state_root / "hermes"
    hermes_home.mkdir()
    env = {
        "PATH": os.environ["PATH"], "HOME": str(state_root / "home"), "TMPDIR": str(state_root / "tmp"),
        "HERMES_HOME": str(hermes_home), "HERMES_WEBUI_STATE_DIR": str(state_root / "state"),
        "HERMES_WEBUI_DEFAULT_WORKSPACE": str(state_root / "workspace"), "HERMES_WEBUI_AGENT_DIR": str(agent_root),
        "HERMES_KANBAN_HOME": str(state_root / "kanban-home"), "HERMES_KANBAN_DB": str(state_root / "kanban-home" / "kanban.db"),
        "HERMES_KANBAN_WORKSPACES_ROOT": str(state_root / "workspaces"), "HERMES_KANBAN_ATTACHMENTS_ROOT": str(state_root / "attachments"),
        "HERMES_WEBUI_HOST": "127.0.0.1", "HERMES_WEBUI_PORT": str(port), "HERMES_WEBUI_PASSWORD": password,
        "HERMES_WEBUI_SKIP_ONBOARDING": "1", "HERMES_WEBUI_TEST_NETWORK_BLOCK": "1", "TALARIA_WEB_WORKER": "1",
    }
    for name in ("home", "tmp", "state", "workspace", "kanban-home"):
        (state_root / name).mkdir(exist_ok=True)
    if os.environ.get("HERMES_WEBUI_PYTHON"):
        env["HERMES_WEBUI_PYTHON"] = os.environ["HERMES_WEBUI_PYTHON"]
    log = (state_root / "server.log").open("w")
    process = subprocess.Popen(["node", str(server_bin), "serve"], cwd=webui_root, env=env, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise VerificationError("server-exited")
        try:
            with build_opener().open(f"http://127.0.0.1:{port}/health", timeout=5) as response:
                if json.load(response).get("status") in ("ok", "degraded"):
                    return process, port
        except (OSError, URLError, ValueError):
            time.sleep(0.25)
    raise VerificationError("server-health")


class ReferenceClient:
    def __init__(self, port: int, password: str):
        self.base_url = f"http://127.0.0.1:{port}"
        self.request_count = 0
        self.mutation_request_count = 0
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        login = Request(self.base_url + "/api/auth/login", data=json.dumps({"password": password}).encode("utf-8"),
                        method="POST", headers={"Content-Type": "application/json"})
        with self.opener.open(login, timeout=10) as response:
            require(response.status == 200, "login")

    def request(
        self,
        label: str,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.request_count += 1
        if method != "GET" and not path.startswith("/api/kanban/dispatch"):
            self.mutation_request_count += 1
        encoded = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            self.base_url + path,
            data=encoded,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                status = response.status
                raw = response.read()
        except HTTPError as error:
            status = error.code
            raw = error.read()
        require(status == 200, f"{label}-http-{status}")
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise VerificationError(f"{label}-json") from error
        require(isinstance(payload, dict), f"{label}-envelope")
        return payload


def verify(client: ReferenceClient) -> dict[str, int]:
    initial_boards = client.request("initial-boards", "GET", "/api/kanban/boards")
    require(isinstance(initial_boards.get("boards"), list), "initial-boards-shape")

    created_board = client.request(
        "create-board",
        "POST",
        "/api/kanban/boards",
        {"slug": "verification", "name": "Verification"},
    )
    require(created_board.get("board", {}).get("slug") == "verification", "create-board-shape")

    updated_board = client.request(
        "update-board",
        "PATCH",
        "/api/kanban/boards/verification",
        {"name": "Reference Verification", "color": "blue"},
    )
    require(updated_board.get("board", {}).get("name") == "Reference Verification", "update-board-shape")

    switched = client.request(
        "switch-board",
        "POST",
        "/api/kanban/boards/verification/switch",
        {},
    )
    require(switched.get("current") == "verification", "switch-board-shape")

    configuration = client.request(
        "configuration",
        "GET",
        "/api/kanban/config?board=verification",
    )
    require(isinstance(configuration.get("columns"), list), "configuration-shape")

    first = client.request(
        "create-first-task",
        "POST",
        "/api/kanban/tasks?board=verification",
        {
            "title": "Reference parent",
            "status": "todo",
            "tenant": "verification",
            "workspace_kind": "scratch",
        },
    )
    second = client.request(
        "create-second-task",
        "POST",
        "/api/kanban/tasks?board=verification",
        {
            "title": "Reference child",
            "status": "triage",
            "tenant": "verification",
            "workspace_kind": "scratch",
        },
    )
    first_id = first.get("task", {}).get("id")
    second_id = second.get("task", {}).get("id")
    require(isinstance(first_id, str) and bool(first_id), "first-task-shape")
    require(isinstance(second_id, str) and bool(second_id), "second-task-shape")

    patched = client.request(
        "patch-task",
        "PATCH",
        f"/api/kanban/tasks/{first_id}?board=verification",
        {
            "title": "Reference parent updated",
            "assignee": "reference-profile",
            "priority": 7,
            "status": "ready",
        },
    )
    require(patched.get("task", {}).get("status") == "ready", "patch-task-shape")

    comment = client.request(
        "comment-task",
        "POST",
        f"/api/kanban/tasks/{first_id}/comments?board=verification",
        {"author": "verifier", "body": "Isolated reference comment"},
    )
    require(comment.get("ok") is True, "comment-shape")

    linked = client.request(
        "link-tasks",
        "POST",
        "/api/kanban/links?board=verification",
        {"parent_id": first_id, "child_id": second_id},
    )
    require(linked.get("ok") is True, "link-shape")

    detail = client.request(
        "task-detail",
        "GET",
        f"/api/kanban/tasks/{second_id}?board=verification",
    )
    require(first_id in detail.get("links", {}).get("parents", []), "detail-links")

    board = client.request(
        "board-snapshot",
        "GET",
        "/api/kanban/board?board=verification",
    )
    task_count = sum(
        len(column.get("tasks", []))
        for column in board.get("columns", [])
        if isinstance(column, dict)
    )
    require(task_count == 2, "board-task-count")

    stats = client.request(
        "board-stats",
        "GET",
        "/api/kanban/stats?board=verification",
    )
    require(isinstance(stats.get("by_status"), dict), "stats-shape")

    assignees = client.request(
        "board-assignees",
        "GET",
        "/api/kanban/assignees?board=verification",
    )
    assignee_names = [
        item.get("name") if isinstance(item, dict) else item
        for item in assignees.get("assignees", [])
    ]
    require("reference-profile" in assignee_names, "assignees-shape")

    events = client.request(
        "board-events",
        "GET",
        "/api/kanban/events?board=verification&since=0&limit=200",
    )
    require(len(events.get("events", [])) > 0, "events-shape")

    log = client.request(
        "task-log",
        "GET",
        f"/api/kanban/tasks/{first_id}/log?board=verification&tail=1024",
    )
    require(log.get("exists") is False, "log-shape")

    blocked = client.request(
        "block-task",
        "POST",
        f"/api/kanban/tasks/{first_id}/block?board=verification",
        {"reason": "Reference verification"},
    )
    require(blocked.get("task", {}).get("status") == "blocked", "block-task-shape")

    unblocked = client.request(
        "unblock-task",
        "POST",
        f"/api/kanban/tasks/{first_id}/unblock?board=verification",
        {},
    )
    require(unblocked.get("task", {}).get("status") in {"todo", "ready"}, "unblock-task-shape")

    bulk = client.request(
        "bulk-update",
        "POST",
        "/api/kanban/tasks/bulk?board=verification",
        {"ids": [first_id, second_id], "priority": 3},
    )
    results = bulk.get("results", [])
    require(len(results) == 2 and all(item.get("ok") for item in results), "bulk-update-shape")

    before_dispatch = client.request(
        "pre-dispatch-detail",
        "GET",
        f"/api/kanban/tasks/{first_id}?board=verification",
    )
    dispatch = client.request(
        "dispatch-dry-run",
        "POST",
        "/api/kanban/dispatch?board=verification&dry_run=true&max=8",
        {},
    )
    require(
        any(
            key in dispatch
            for key in (
                "spawned",
                "promoted",
                "reclaimed",
                "skipped_unassigned",
                "skipped_nonspawnable",
            )
        ),
        "dispatch-shape",
    )
    after_dispatch = client.request(
        "post-dispatch-detail",
        "GET",
        f"/api/kanban/tasks/{first_id}?board=verification",
    )
    require(
        before_dispatch.get("task", {}).get("status")
        == after_dispatch.get("task", {}).get("status"),
        "dispatch-mutated-status",
    )
    require(dispatch.get("spawned", 0) in (0, [], None), "worker-spawn-attempted")

    unlinked = client.request(
        "unlink-tasks",
        "DELETE",
        "/api/kanban/links?board=verification",
        {"parent_id": first_id, "child_id": second_id},
    )
    require(unlinked.get("ok") is True, "unlink-shape")

    archived_task = client.request(
        "archive-task",
        "POST",
        "/api/kanban/tasks/bulk?board=verification",
        {"ids": [second_id], "archive": True},
    )
    require(archived_task.get("results", [{}])[0].get("ok") is True, "archive-task-shape")

    archived_board = client.request(
        "archive-board",
        "DELETE",
        "/api/kanban/boards/verification",
        {},
    )
    require(archived_board.get("current") == "default", "archive-board-shape")
    require(
        archived_board.get("result", {}).get("action") == "archived",
        "archive-board-result",
    )

    final_boards = client.request(
        "final-boards",
        "GET",
        "/api/kanban/boards?include_archived=true",
    )
    require(
        all(item.get("slug") != "verification" for item in final_boards.get("boards", [])),
        "archived-board-removal",
    )

    return {
        "requests": client.request_count,
        "mutations": client.mutation_request_count,
        "worker_spawns": 0,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", type=Path, required=True)
    parser.add_argument("--webui-root", type=Path, required=True, help="The monorepo web/ directory with packages/server built.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix="talaria-kanban-reference-") as temporary:
            state_root = Path(temporary)
            password = "talaria-kanban-reference"
            process, port = boot_server(args.agent_root.resolve(), args.webui_root.resolve(), state_root, password)
            try:
                evidence = verify(ReferenceClient(port, password))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
    except (OSError, subprocess.SubprocessError, VerificationError) as error:
        label = str(error) if isinstance(error, VerificationError) else type(error).__name__
        print(f"result=failed check={label}")
        return 1

    print(
        "result=passed "
        f"requests={evidence['requests']} "
        f"mutations={evidence['mutations']} "
        "dispatcher_mode=dry_run "
        f"worker_spawns={evidence['worker_spawns']} "
        "temporary_state=removed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
