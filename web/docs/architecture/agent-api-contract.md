# Web to Hermes Agent dependency contract

Talaria Web depends on Hermes Agent through exactly one boundary: the Python
sidecar (`sidecar/talaria_sidecar`, [sidecar-rpc.md](sidecar-rpc.md)). The
TypeScript server imports no Agent code and reads Agent-owned files only as file
formats (`config.yaml`, `.env`, profiles, skills, memories, `state.db` read-only
projection). Every Agent module import lives in the sidecar's `methods/`
package, on the Agent's own venv interpreter.

## Tested identity

`sidecar/agent_dependency.json` records the tested external Agent: an exact
package version, source commit, and image digest. The launcher fetches the
installer from that commit when it installs an Agent; existing installations are
discovered and retained, never downgraded. Both multi-container Compose variants
inherit their Agent image from the same file through Compose `extends`.

At handshake the sidecar compares the loaded Agent revision with the pin and
reports `{agent_revision, agent_version, pinned_revision, pinned_version,
compatible, stale, update_state}`. The server trusts that report and answers
Agent-backed routes with `503 agent_incompatible` (a different revision) or
`503 agent_runtime_stale` (the checkout changed while running) until the sidecar
restarts on a healthy checkout. `/health` exposes the same `compatibleAgent`
identity in its `release` block (`tag, version, sourceRevision, releaseSet,
contracts, compatibleAgent`); it names the tested dependency, not whichever Agent
an operator installed.

Run `python3 scripts/check-agent-compatibility.py` from the monorepo root when
changing the pin or preparing a release. The gate fetches only the pinned
source, installs its locked dependencies, exercises real Agent imports and the
sidecar's `SessionDB` write path, runs the sidecar pytest suite on that
interpreter, and (unless `--skip-docker`) repeats the probe against the
digest-pinned container with networking disabled. It uses disposable homes and
databases and never production credentials or provider requests. A passing
identity is a tested combination, not a requirement that independently installed
Agent or peer component versions be equal.

## Dependency classes

| Class | Sidecar namespace | Agent modules |
|---|---|---|
| Chat execution | `chat.*`, `approval.*`, `goals.*` | `run_agent.AIAgent`, `tools.approval`, `hermes_cli.goals` |
| Profiles and configuration | `profiles.*`, `config.*` | `hermes_cli.profiles`, `hermes_cli.config` |
| Commands and plugins | `commands.*`, `plugins.*`, `skills.*` | `hermes_cli.commands`, `hermes_cli.plugins`, `agent.skill_utils` |
| Providers and models | `providers.*`, `models.*`, `aux.*` | `hermes_cli.models`, `hermes_cli.auth`, `agent.credential_pool`, `agent.auxiliary_client`, `agent.model_metadata` |
| Scheduling | `cron.*`, `kanban.*`, `process.*` | `cron.jobs`, `cron.scheduler`, `hermes_cli.kanban_db`, the process registry |
| Session state | `state_db.*` | `hermes_state.SessionDB` |
| Text and media | `text.*`, `stt.*`, `mcp.*` | `agent.redact`, STT helpers, MCP discovery |
| Gateway lifecycle | `gateway.*`, `worktree.*` | the `hermes` CLI |

Adding a dependency means adding a sidecar method with its Zod schema in
`packages/contracts/src/sidecar/namespaces.ts`, a recorded fixture, and a
pytest case; the server side consumes the typed result only.

## state.db message content encoding

The server projects `state.db` read-only (`packages/server/src/sessions/state-db.ts`)
and must decode the Agent's `\x00json:`-prefixed message content the same way
the Agent writes it. The decode rules and the sentinel handling for `NaN` /
`Infinity` floats are covered by the state-db tests; writes (session start,
usage, titles, deletion) go through the sidecar so the storage format stays
Agent-owned.
