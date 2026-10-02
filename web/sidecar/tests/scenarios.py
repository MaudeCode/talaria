"""Ordered sidecar scenarios shared by the pytest suite and the fixture recorder.

Each scenario is ``(method, params)`` executed against one sidecar with an
isolated HERMES_HOME. ``{home}`` and ``{profile}`` are substituted; results
are validated against the contracts package JSON Schemas and, in record mode,
written as fixtures with the temporary paths normalized back to placeholders.
Methods that need credentials or the network are exercised only for their
fail-closed shapes.
"""

from __future__ import annotations

SCENARIOS: list[tuple[str, dict]] = [
    ("runtime.status", {}),
    ("runtime.ensure_current", {}),
    ("runtime.env", {"set": {"TALARIA_SCENARIO_KEY": "sk-synthetic"}, "unset": ["TALARIA_SCENARIO_KEY"]}),
    ("rpc.methods", {}),
    ("rpc.cancel", {"id": 424242}),
    # goals
    ("goals.get", {"session_id": "sess-1", "profile_home": "{home}"}),
    ("goals.command", {"session_id": "sess-1", "profile_home": "{home}", "args": "ship the sidecar"}),
    ("goals.snapshot", {"session_id": "sess-1", "profile_home": "{home}"}),
    ("goals.evaluate", {"session_id": "sess-1", "profile_home": "{home}", "last_response": "Done: the sidecar shipped."}),
    ("goals.command", {"session_id": "sess-1", "profile_home": "{home}", "args": "pause"}),
    ("goals.command", {"session_id": "sess-1", "profile_home": "{home}", "args": "resume"}),
    ("goals.restore", {"session_id": "sess-1", "profile_home": "{home}", "snapshot": None}),
    ("goals.command", {"session_id": "sess-1", "profile_home": "{home}", "args": "clear"}),
    # commands / plugins
    ("commands.registry", {"profile_home": "{home}"}),
    ("commands.exec", {"profile_home": "{home}", "command": "/reload-skills"}),
    ("commands.moa_preset", {"profile_home": "{home}", "preset": None}),
    ("plugins.list", {"profile_home": "{home}"}),
    ("plugins.providers", {"profile_home": "{home}"}),
    # profiles
    ("profiles.list", {"base_home": "{home}"}),
    ("profiles.create", {"base_home": "{home}", "name": "alpha"}),
    ("profiles.runtime_env", {"profile_home": "{profile}", "protected_keys": []}),
    ("profiles.skills_stats", {"profile_home": "{profile}"}),
    # skills (the seeded profile has bundled skills)
    ("skills.list", {"profile_home": "{profile}"}),
    ("skills.list", {"profile_home": "{profile}", "category": "apple"}),
    ("skills.find", {"profile_home": "{profile}", "name": "apple-notes"}),
    ("skills.view", {"profile_home": "{profile}", "name": "apple-notes"}),
    ("skills.view", {"profile_home": "{profile}", "name": "does-not-exist"}),
    ("profiles.delete", {"base_home": "{home}", "name": "alpha"}),
    # kanban
    ("kanban.boards", {"profile_home": "{home}"}),
    ("kanban.create_board", {"profile_home": "{home}", "board_spec": {"slug": "experiments", "name": "Experiments"}}),
    ("kanban.update_board", {"profile_home": "{home}", "slug": "experiments", "board_spec": {"description": "scratch"}}),
    ("kanban.switch_board", {"profile_home": "{home}", "slug": "experiments"}),
    ("kanban.switch_board", {"profile_home": "{home}", "slug": "default"}),
    ("kanban.delete_board", {"profile_home": "{home}", "slug": "experiments"}),
    ("kanban.create_task", {"profile_home": "{home}", "task": {"title": "first task", "body": "details", "priority": 2}}),
    ("kanban.create_task", {"profile_home": "{home}", "task": {"title": "second task"}}),
    ("kanban.board", {"profile_home": "{home}"}),
    ("kanban.board", {"profile_home": "{home}", "since": 10_000}),
    ("kanban.config", {"profile_home": "{home}"}),
    ("kanban.stats", {"profile_home": "{home}"}),
    ("kanban.assignees", {"profile_home": "{home}"}),
    ("kanban.normalize_board", {"profile_home": "{home}", "board": "default"}),
    ("kanban.events", {"profile_home": "{home}", "since": 0, "limit": 50}),
    ("kanban.dispatch", {"profile_home": "{home}", "dry_run": True}),
    # state_db
    ("state_db.sync_start", {"profile_home": "{home}", "session_id": "webui-1", "model": "test-model"}),
    ("state_db.sync_usage", {"profile_home": "{home}", "session_id": "webui-1", "input_tokens": 10, "output_tokens": 5, "title": "Hello", "message_count": 2}),
    ("state_db.sync_title", {"profile_home": "{home}", "session_id": "webui-1", "title": "Hello again"}),
    ("state_db.delete_cli_session", {"profile_home": "{home}", "session_id": "cli-1"}),
    ("state_db.delete_cli_session", {"profile_home": "{home}", "session_id": "missing"}),
    # mcp / stt
    ("mcp.status", {"profile_home": "{home}"}),
    ("mcp.registry_tools", {"profile_home": "{home}"}),
    ("stt.capability", {"profile_home": "{home}"}),
    # cron
    ("cron.list", {"profile_home": "{home}"}),
    ("cron.create", {"profile_home": "{home}", "job": {"schedule": "every 1h", "prompt": "say hi", "name": "hello"}}),
    ("cron.delivery_options", {}),
    ("cron.status", {}),
    # providers / models / aux / text / process
    ("config.get", {"profile_home": "{home}", "config_path": "{home}/config.yaml"}),
    ("models.reasoning_efforts", {"profile_home": "{home}", "model": "claude-sonnet-4-6", "provider": "anthropic"}),
    ("providers.registry", {"profile_home": "{home}"}),
    ("providers.auth_status", {"profile_home": "{home}", "provider": "anthropic"}),
    ("providers.model_ids", {"profile_home": "{home}", "provider": "anthropic"}),
    ("providers.credential_pool", {"profile_home": "{home}", "provider": "anthropic"}),
    ("models.context_length", {"profile_home": "{home}", "model": "claude-sonnet-4-5", "provider": "anthropic"}),
    ("models.estimate_tokens", {"messages": [{"role": "user", "content": "hello world"}]}),
    ("models.capabilities", {"profile_home": "{home}", "provider": "anthropic", "model": "claude-sonnet-4-5"}),
    ("aux.resolve", {"profile_home": "{home}", "task": "title_generation"}),
    ("text.redact", {"text": "token sk-abcdef1234567890abcdef1234567890 and AKIAIOSFODNN7EXAMPLE"}),
    ("text.portal_tags", {"profile_home": "{home}"}),
    ("text.image_mode", {"profile_home": "{home}", "provider": "anthropic", "model": "claude-sonnet-4-5"}),
    ("process.drain", {"profile_home": "{home}"}),
    ("process.list", {"profile_home": "{home}"}),
    ("process.format_notification", {"event": {"type": "completion", "session_id": "proc_1", "command": "ls", "exit_code": 0, "output": "ok"}}),
    ("process.requeue", {"events": []}),
    ("process.mark_consumed", {"process_id": "proc_1"}),
    ("process.claim_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture", "task_failure_notice": True}, "consumer": "webui"}),
    ("process.complete_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture"}, "claim_id": ""}),
    ("process.release_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture"}, "claim_id": ""}),
    ("process.defer_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture"}, "claim_id": ""}),
]

# Scenarios whose params hold ids produced by earlier calls; resolved at run time.
DYNAMIC: list[tuple[str, str]] = [
    ("kanban.task", "task_id"), ("kanban.patch_task", "task_id"), ("kanban.task_action", "task_id"), ("kanban.comment", "task_id"),
    ("kanban.link", "parent_id"), ("kanban.unlink", "parent_id"), ("kanban.task_log", "task_id"), ("kanban.bulk", "bulk"),
    ("cron.get", "job_id"), ("cron.update", "job_id"), ("cron.pause", "job_id"), ("cron.resume", "job_id"), ("cron.history", "job_id"),
    ("cron.output", "job_id"), ("cron.run_detail", "job_id"), ("cron.delete", "job_id"), ("cron.status", "job_id"),
]

# Methods deliberately not exercised here: they need credentials, the
# network, a running gateway, or a real audio file.
UNEXERCISED = {"runtime.handshake", "runtime.shutdown", "goals.restore", "commands.exec", "kanban.dispatch",
               "providers.resolve_runtime", "aux.complete", "stt.transcribe", "usage.account", "gateway.restart", "mcp.reload", "cron.run",
               "worktree.create", "chat.start", "chat.interrupt", "chat.steer", "chat.evict_agent", "chat.commit_memory", "approval.respond", "approval.pending", "approval.set_yolo", "clarify.respond", "config.set"}
