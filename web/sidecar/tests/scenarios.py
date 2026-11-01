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
    ('drafts.review', {'profile_home': '{home}', 'session_id': 'fixture-session', 'draft_id': 'd_1234abcd', 'card': 1, 'action': 'read'}),
    ("chat.context_detail", {"profile_home": "{home}", "session_id": "context-not-built", "model": None, "model_provider": None, "workspace": None}),
    ("chat.finalize_session", {"profile_home": "{home}", "session_id": "finalize-test", "reason": "clear"}),
    ("chat.finalize_session", {"profile_home": "{home}", "session_id": "archive-test", "reason": "archive", "lineage": ["archive-test", "archive-tip"]}),
    ("runtime.status", {}),
    ("runtime.agent_recovery", {"probe": True}),
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
    ("toolsets.catalog", {"profile_home": "{home}", "enabled_toolsets": None}),
    # commands / plugins
    ("commands.registry", {"profile_home": "{home}"}),
    ("commands.exec", {"profile_home": "{home}", "command": "/reload-skills"}),
    ("commands.moa_preset", {"profile_home": "{home}", "preset": None}),
    # TAL-817: the first entry is FakeSidecar's default, so slash text in server tests stays the user's own message.
    ("commands.expand_prompt", {"profile_home": "{home}", "command": "/etc/hosts looks wrong", "workspace": "{home}", "enabled_toolsets": None}),
    ("commands.expand_prompt", {"profile_home": "{home}", "command": "/plan add a dark mode", "workspace": "{home}", "enabled_toolsets": None}),
    ("plugins.list", {"profile_home": "{home}"}),
    ("plugins.buffers", {"profile_home": "{home}", "session_id": "synthetic-no-buffers", "action": "list"}),
    ("plugins.dashboard_list", {"profile_home": "{home}"}),
    ("plugins.dashboard_asset", {"profile_home": "{home}", "name": "not-installed", "path": "dist/index.html"}),
    ("plugins.dashboard_request", {"profile_home": "{home}", "name": "not-installed", "path": "/", "method": "GET", "query": "", "headers": {}, "body": "", "authenticated": True, "websocket": False}),
    ("plugins.providers", {"profile_home": "{home}"}),
    ("plugins.isolation", {"base_home": "{home}"}),
    # profiles
    ("profiles.list", {"base_home": "{home}"}),
    ("profiles.create", {"base_home": "{home}", "name": "alpha"}),
    ("profiles.import", {"profile_home": "{profile}", "action": "discover"}),
    ("profiles.runtime_env", {"profile_home": "{profile}", "protected_keys": []}),
    ("profiles.skills_stats", {"profile_home": "{profile}"}),
    ("profiles.skills_stats_invalidate", {"profile_home": "{profile}"}),
    ("gateway.mode", {"profile_home": "{home}", "name": "default", "is_default": True}),
    ("gateway.ownership", {"profile_home": "{home}", "port": 8642}),
    ("gateway.session", {"profile_home": "{home}", "session_id": "not-running", "action": "snapshot"}),
    ("gateway.create", {"profile_home": "{home}", "probe": True}),
    ("gateway.groups", {"profile_home": "{home}", "subject": "fixture-owner", "operation": {"action": "capabilities"}}),
    ("gateway.mode", {"profile_home": "{profile}", "name": "alpha", "is_default": False}),
    # skills (the seeded profile has bundled skills)
    ("skills.list", {"profile_home": "{profile}"}),
    ("skills.list", {"profile_home": "{profile}", "category": "apple"}),
    ("skills.find", {"profile_home": "{profile}", "name": "apple-notes"}),
    ("skills.view", {"profile_home": "{profile}", "name": "apple-notes"}),
    ("skills.view", {"profile_home": "{profile}", "name": "does-not-exist"}),
    ("skills.revisions", {"profile_home": "{profile}", "name": "apple-notes"}),
    ("skills.replay_plan", {"profile_home": "{profile}", "name": "apple-notes", "baseline": "a" * 64, "candidate": "b" * 64}),
    # skill bundles (run_scenarios seeds the profile's media-kit bundle; one member is not installed)
    ("commands.bundles", {"profile_home": "{profile}"}),
    ("commands.bundle_resolve", {"profile_home": "{profile}", "command": "/media-kit find a cat"}),
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
    ("kanban.inspection", {"profile_home": "{home}"}),
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
    ("state_db.append_message", {"profile_home": "{home}", "session_id": "webui-1", "role": "tool", "content": "{\"_handoff_summary_card\": true, \"session_id\": \"webui-1\", \"summary\": \"- Ship it.\"}", "tool_name": "handoff_summary", "timestamp": 1.0}),
    ("state_db.delete_cli_session", {"profile_home": "{home}", "session_id": "cli-1"}),
    ("state_db.delete_cli_session", {"profile_home": "{home}", "session_id": "missing"}),
    ("state_db.prune_advice", {"profile_home": "{home}"}),
    # mcp / stt / usage (a provider with no account-usage fetcher answers offline)
    ("mcp.cost_policies", {"profile_home": "{home}", "servers": {"paid": {"command": "never-spawn", "tool_costs": {"search": {"credits": [1, 3], "note": "estimate"}}, "spend_limit": 5}}}),
    ("mcp.probe_targets", {"profile_home": "{home}", "servers": {"remote": {"url": "https://mcp.invalid/mcp", "headers": {"Authorization": "Bearer ${TALARIA_SCENARIO_UNSET}", "X-Literal": "literal-value"}}, "local": {"command": "never-spawn"}}}),
    ("mcp.status", {"profile_home": "{home}"}),
    ("mcp.registry_tools", {"profile_home": "{home}"}),
    ("stt.capability", {"profile_home": "{home}"}),
    ("stt.warm", {"profile_home": "{home}"}),
    ("usage.account", {"profile_home": "{home}", "provider": "zai"}),
    ("usage.pool", {"profile_home": "{home}", "provider": "deepseek"}),
    ("usage.pool_providers", {"profile_home": "{home}"}),
    ("usage.balance", {"profile_home": "{home}", "provider": "deepseek"}),
    ("usage.limits", {"profile_home": "{home}", "providers": [{"slug": "deepseek", "models": ["deepseek-chat"]}]}),
    # cron
    ("cron.blueprints", {"profile_home": "{home}"}),
    ("cron.blueprint_fill", {"profile_home": "{home}", "key": "morning-brief", "values": {"time": "08:30"}}),
    ("cron.list", {"profile_home": "{home}"}),
    ("cron.create", {"profile_home": "{home}", "job": {"schedule": "every 1h", "prompt": "say hi", "name": "hello"}}),
    ("cron.delivery_options", {"profile_home": "{home}"}),
    ("cron.status", {}),
    # providers / models / aux / text / process
    ("config.get", {"profile_home": "{home}", "config_path": "{home}/config.yaml"}),
    ("config.env_write", {"profile_home": "{home}", "updates": {"TALARIA_FIXTURE_KEY": "sk-fixture-1234", "TALARIA_ABSENT_KEY": None}}),
    ("models.reasoning_efforts", {"profile_home": "{home}", "model": "claude-sonnet-4-6", "provider": "anthropic"}),
    # TAL-901: a top-level block entry, case-folded, after the Agent's built-ins.
    ("personalities.list", {"config": {"personalities": {"Reviewer": "You review code tersely."}}}),
    ("providers.registry", {"profile_home": "{home}"}),
    ("providers.nous_account", {"profile_home": "{home}"}),
    ("providers.auth_status", {"profile_home": "{home}", "provider": "anthropic"}),
    ("providers.model_ids", {"profile_home": "{home}", "provider": "anthropic"}),
    ("providers.local_models", {"profile_home": "{home}"}),
    ("providers.credential_pool", {"profile_home": "{home}", "provider": "anthropic"}),
    ("models.speed_tiers", {"profile_home": "{home}", "routes": [
        {"model": "gpt-6-astra", "provider": "openai-codex", "base_url": "https://chatgpt.com/backend-api/codex"},
        {"model": "gpt-6-sol", "provider": "openai-codex", "base_url": "https://chatgpt.com/backend-api/codex"},
        {"model": "gpt-6.1-sol", "provider": "openai-api", "base_url": "https://api.openai.com/v1"},
        {"model": "claude-opus-4-8", "provider": "anthropic", "base_url": "https://api.anthropic.com"},
        {"model": "gpt-6-astra", "provider": "openai", "base_url": "https://proxy.example/v1"},
    ]}),
    ("models.context_length", {"profile_home": "{home}", "model": "claude-sonnet-4-5", "provider": "anthropic"}),
    ("models.estimate_tokens", {"messages": [{"role": "user", "content": "hello world"}]}),
    ("models.capabilities", {"profile_home": "{home}", "provider": "anthropic", "model": "claude-sonnet-4-5"}),
    ("aux.resolve", {"profile_home": "{home}", "task": "title_generation"}),
    ("aux.tasks", {"profile_home": "{home}"}),
    ("text.portal_tags", {"profile_home": "{home}"}),
    ("text.image_mode", {"profile_home": "{home}", "provider": "anthropic", "model": "claude-sonnet-4-5"}),
    # TAL-906: identifiers go silent; prose, dates, emails, and ratios stay as written.
    ("text.spoken", {"text": "Saved peyton-sample-20260922.wav to /tmp/out/9f2c1e7a-3b4d-4c2e-8f1a-0b9e2d7c6a51.json, see https://example.com/a/b?x=1 and commit 4bf46b7c8."}),
    ("text.spoken", {"text": "Meet Ana on 2026-10-14 at ana@example.com; the ratio is 3:2, a well-known plan."}),
    ("memory.check", {"profile_home": "{home}", "target": "memory", "content": "User prefers tabs\n§\nDeploy box is 10.0.0.5"}),
    ("memory.check", {"profile_home": "{home}", "target": "user", "content": "x" * 1400}),
    # TAL-784: a save over a USER.md that does not exist yet (the SHA-256 of no bytes).
    ("memory.write", {"profile_home": "{home}", "section": "user", "base": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "content": "User prefers tabs"}),
    # The same base again is stale now that USER.md exists: refused, not written.
    ("memory.write", {"profile_home": "{home}", "section": "user", "base": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "content": "Stale save"}),
    ("process.drain", {"profile_home": "{home}"}),
    ("process.list", {"profile_home": "{home}"}),
    ("process.stop", {"profile_home": "{home}", "session_id": "webui-fixture", "process_id": "proc_fixture_missing"}),
    ("process.format_notification", {"event": {"type": "completion", "session_id": "proc_1", "command": "ls", "exit_code": 0, "output": "ok"}}),
    ("process.format_notification", {"event": {"type": "heartbeat", "session_id": "proc_1", "command": "npm test", "seq": 1, "interval": 60, "elapsed": 61, "output": "test passed", "started_at": 10}}),
    ("process.recover", {"base_home": "{home}"}),
    ("process.requeue", {"events": []}),
    ("process.mark_consumed", {"process_id": "proc_1"}),
    ("process.consumed", {"process_ids": ["proc_1", "proc_2"]}),
    ("process.claim_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture", "task_failure_notice": True}, "consumer": "webui"}),
    ("process.complete_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture"}, "claim_id": ""}),
    ("process.release_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture"}, "claim_id": ""}),
    ("process.defer_delivery", {"profile_home": "{home}", "event": {"type": "async_delegation", "delegation_id": "deleg_fixture"}, "claim_id": ""}),
    ("process.background_list", {"profile_home": "{home}", "session_ids": ["webui-fixture"]}),
    ("process.delegation_result", {"profile_home": "{home}", "session_id": "webui-fixture", "delegation_id": "deleg_fixture"}),
    # TAL-806: test_namespaces seeds a synthetic plugin that declares settings before this; last, so no earlier fixture sees its config write.
    ("plugins.settings", {"profile_home": "{home}"}),
    ("plugins.settings_save", {"profile_home": "{home}", "key": "fake-settings", "values": {"limit": 9, "mode": "careful"}}),
    ("plugins.oauth_status", {"profile_home": "{home}"}),
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
# TTS registration, profile scope and bounded audio are covered by test_tts and the installed-Agent probe, without live synthesis.
# plugins.update needs an owned Git install and newer Agent APIs; test_plugin_updates covers its registered handler and scan transaction.
# plugins.catalog/install use the pinned local Git fixture in test_plugin_catalog, including typed replies and native publication.
UNEXERCISED = {"plugins.catalog", "plugins.install", "plugins.update", "models.selection_warnings", "runtime.agent_mutation", "runtime.sync_dependencies", "runtime.handshake", "runtime.shutdown", "goals.restore", "commands.exec",
               "providers.resolve_runtime", "oauth.start", "oauth.poll", "oauth.cancel", "oauth.submit_redirect", "plugins.oauth_logout", "aux.complete", "tts.synthesize", "stt.transcribe", "stt.stream", "stt.stream_audio", "gateway.control", "gateway.restart", "mcp.reload", "cron.run",
               "worktree.create", "worktree.retain", "chat.start", "chat.interrupt", "chat.steer", "chat.steer_withdraw", "chat.steer_now", "chat.evict_agent", "chat.commit_memory", "chat.refine", "chat.compress", "chat.compress_finalize", "approval.respond", "approval.pending", "approval.set_yolo", "clarify.respond", "config.set"}

# Enabling a plugin is covered with synthetic profile fixtures by test_dashboard_plugins.py and test_dashboard_host_compat.py.
UNEXERCISED.add("plugins.dashboard_toggle")

# A replay case sends a provider request; test_skill_replay.py covers it with a fake transport.
UNEXERCISED.add("skills.replay_case")

# Delegation edits are covered by the disposable native configuration contract test.
UNEXERCISED.update({"aux.delegation", "aux.delegation_backend", "aux.delegation_routes"})
