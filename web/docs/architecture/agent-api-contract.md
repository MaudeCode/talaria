# Web to Hermes Agent dependency contract

Talaria Web depends on Hermes Agent through exactly one boundary: the Python
sidecar (`sidecar/talaria_sidecar`, [sidecar-rpc.md](sidecar-rpc.md)). The
TypeScript server imports no Agent code and reads Agent-owned files only as file
formats (`config.yaml`, `.env`, profiles, skills, memories, `state.db` read-only
projection). Every Agent module import lives in the sidecar's `methods/`
package, on the Agent's own venv interpreter.

## Tested identity

`sidecar/agent_dependency.json` records the tested external Agent: a stable
release tag, its exact package version and peeled source commit, and the release
image digest. The launcher fetches the installer from that commit when it
installs an Agent; existing installations are discovered and retained, never
downgraded. Both multi-container Compose variants inherit their Agent image from
the same file through Compose `extends`.

At handshake the sidecar reports `{agent_revision, agent_version, pinned_revision,
pinned_version, compatible, stale, update_state}`. `compatible` means the Agent
imported; a different revision than the pin gets a warning and can attempt Agent
operations. Individual methods refuse missing capabilities and named-profile
credential isolation failures. A checkout changed after import returns
`503 agent_runtime_stale` for Agent operations until restart. `config.get` and
`config.set` remain available after an Agent import failure if the RPC handshake
and YAML parser work, so operator auth and repair do not depend on Agent imports.
`/health` exposes the same `compatibleAgent`
identity in its `release` block (`tag, version, sourceRevision, releaseSet,
contracts, compatibleAgent`); it names the tested dependency, not whichever Agent
an operator installed.

Run `python3 scripts/check-agent-compatibility.py` from the monorepo root when
changing the pin or preparing a release. The gate fetches only the pinned
release tag, requires it to peel to the recorded commit, installs its locked
dependencies, exercises real Agent imports and the sidecar's `SessionDB` write
path, and runs the sidecar pytest suite on that interpreter. Unless
`--skip-docker` is set, it also requires the release-tagged image to match the
recorded digest and repeats the probe against that digest with networking
disabled. It uses disposable homes and databases and never production
credentials or provider requests. A passing identity is a tested combination,
not a requirement that independently installed Agent or peer component versions
be equal. Unreleased Agent `main` canaries never change this pin.

The compatibility gate proves Talaria's existing calls still work; it cannot see
new Agent capabilities. For what a release or `main` SHA adds, modifies,
deprecates or removes, run the read-only
[`hermes-agent-release-review`](../../../.agents/skills/hermes-agent-release-review/SKILL.md)
skill: `python3 scripts/review-agent-range.py prepare --base <reviewed SHA>
--candidate <tag|main>` prepares the exact range, and the skill classifies each
change against the sidecar, contracts, server and UI. Its report is advisory and
never changes the pin.

## Dependency classes

| Class | Sidecar namespace | Agent modules |
|---|---|---|
| Chat execution | `chat.*`, `approval.*`, `goals.*` | `run_agent.AIAgent`, `tools.approval`, `hermes_cli.goals` |
| Profiles | `profiles.*` | `hermes_cli.profiles` |
| Operator configuration | `config.*` | YAML parser on the Agent interpreter; no Agent import required |
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
