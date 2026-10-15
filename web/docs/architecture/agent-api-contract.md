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

`sidecar/agent_support.json` lists exactly three stable Agent releases Talaria
supports, each with its tag, package version, peeled commit, release image
digest, and the ticket that validated it. The active pin must be one of them;
the checker refuses a record with any other count, a repeated identity, a
mutable reference, or a pin outside the set. Promoting a newer release replaces
the oldest entry only after the candidate passes.

At handshake the sidecar reports `{agent_revision, agent_version, pinned_revision,
pinned_version, compatible, stale, update_state}`. `compatible` means the Agent
imported; a different revision than the pin gets a warning and can attempt Agent
operations. Individual methods refuse missing capabilities and named-profile
credential isolation failures. A checkout changed after import returns
`503 agent_runtime_stale` for Agent operations until restart. `config.get` and
`config.set` remain available after an Agent import failure if the RPC handshake
and YAML parser work, so operator auth and repair do not depend on Agent imports.
Config saves use the Agent's comment-preserving full-state replacement writer when available,
including deliberate key removals. The sidecar stages the resolved file's document and checks
the original symlink again before replacing its target, retaining the target's permissions.
Older Agents and failed Agent imports use the YAML parser with line folding disabled so paths
and prompts containing backslashes survive a save unchanged. Writer failures propagate without
falling back to a rewrite that would discard comments.
`/health` exposes the same `compatibleAgent`
identity in its `release` block (`tag, version, sourceRevision, releaseSet,
contracts, compatibleAgent`); it names the tested dependency, not whichever Agent
an operator installed.

Run `python3 scripts/check-agent-compatibility.py` from the monorepo root when
changing the pin or preparing a release; `--release TAG` checks one supported
release, `--identity JSON` an unpromoted candidate, and `--main SHA` an Agent
`main` canary. Pull requests that change the sidecar, its contracts, the
checker, or the record run it for all three supported releases, and the release
gate repeats that against the release plan's Web source. The gate requires a
published, non-prerelease GitHub release, fetches only that release tag,
requires it to peel to the recorded commit, installs its locked dependencies on
the newest Python the lockfile allows, exercises real Agent imports and the
sidecar's `SessionDB` write path, and runs the sidecar pytest suite on that
interpreter. `--receipt PATH` writes the result, failing or not, with test
counts, the Python and Web revisions, and the JUnit report beside it. Unless
`--skip-docker` is set, it also requires the recorded digest's image to come
from the recorded commit (its OCI revision label, or a clean CI build stamp on
images that have none) and to be published under the release tag or the
`rc.N-<tag>` release attempt whose Git tag is that commit, then repeats the
probe against that digest with networking disabled. It uses disposable homes and databases and never production
credentials or provider requests. A passing identity is a tested combination,
not a requirement that independently installed Agent or peer component versions
be equal. Unreleased Agent `main` canaries never change this pin or the
support record.

The compatibility gate proves Talaria's existing calls still work; it cannot see
new Agent capabilities. For what a release or `main` SHA adds, modifies,
deprecates or removes, run the
[`upstream-release-review`](../../../.agents/skills/upstream-release-review/SKILL.md)
skill: `python3 scripts/review-agent-range.py prepare --base <reviewed SHA>
--candidate <tag|main>` prepares the exact range, and the skill classifies each
change against the sidecar, contracts, server and UI. It files validated bugs
and features in Kaneo, holds other findings for owner approval, and never
changes the pin.

## Dependency classes

| Class | Sidecar namespace | Agent modules |
|---|---|---|
| Chat execution | `chat.*`, `approval.*`, `goals.*` | `run_agent.AIAgent`, `tools.approval`, `hermes_cli.goals` |
| Profiles | `profiles.*` | `hermes_cli.profiles` |
| Operator configuration | `config.*`, `personalities.*` | YAML parser on the Agent interpreter; no Agent import required for `config.get`/`config.set`; `hermes_cli.personality` (the personality catalog) |
| Commands and plugins | `commands.*`, `plugins.*`, `skills.*` | `hermes_cli.commands`, `hermes_cli.plugins`, `agent.skill_utils`, the prompt builders (`agent.plan_prompt`, `agent.learn_prompt`, `agent.initiate_setup_prompt`, `hermes_cli.init_command`) |
| Providers and models | `providers.*`, `models.*`, `aux.*` | `hermes_cli.models`, `hermes_cli.auth`, `hermes_cli.main_provider_setup` (aux slot list), `agent.credential_pool`, `agent.auxiliary_client`, `agent.model_metadata` |
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

Content decoding removes exactly one JSON wrapper and accepts any parsed JSON
value, including a literal string beginning with the reserved prefix. Malformed
JSON keeps its raw text. Child goal extraction uses the Agent's decoder when
available and the same rules locally for older Agents.
The public message projection converts decoded objects, numbers, and booleans
to JSON text before redaction, preserving credential-key context and the existing
client message contract.
If an integer anywhere in the payload exceeds JavaScript's safe range, the
server preserves the payload as JSON text instead of rounding it. Ordinary
multimodal arrays continue to decode as parts.

## Skill catalog identities

On Agents with the resolved skill catalog, `skills.list` uses the Agent's search
roots and precedence. Each loadable row's `name` and `load_name` are the same
canonical identifier; `declared_name`, `status`, and `tier` retain the catalog
metadata. Same-tier duplicates use exact relative paths, and shadowed or
unloadable rows are omitted. Disabled rows remain visible for management.
`skills.view` and `skills.find` use the Agent's lookup and reject ambiguous bare
names. Inspection reads the file without executing skill preprocessing.
Toggles persist the resolved identifier; enabling one copy expands an older
bare-name disable into the other copies' identifiers, including hidden copies.
Global and Web platform disables both contribute to the displayed state.
Skill content carries an `editable` capability: project, external, plugin, and
legacy flat-file skills are read-only. Save and Delete resolve the selected
local file through the same lookup and retain anchored filesystem protections;
they never mutate a shadowed local copy in place of a project skill.
Older Agents without these helpers retain the legacy list and lookup shapes.

## Session deletion

`state_db.delete_cli_session` uses the installed Agent's canonical deletion transaction
when runtime-ledger retirement is available. The Agent resolves compression segments
in both directions, receipt-backed local resets, and owned delegates; independent
branches and reset forks survive. Queued, executing or unknown ledger work and live
turn/compression guards refuse the whole operation with `refused: active_turn`.
Terminal admission and worker receipts retire with the session, retaining retry
evidence without transcript copies. The Agent's tombstones prevent late accounting
from recreating deleted sessions. Older supported Agents retain the guarded legacy
deletion path.

Talaria writes its transcript cleanup manifest inside the same database transaction,
before commit. A manifest failure rolls back deletion and retirement. File cleanup
runs only after commit and retries pending manifests on the next delete, including
after a sidecar restart. Cleanup checks surviving session IDs before removing files.
The mutated state layers are the Agent database and its transcript artifacts; the
HTTP server removes its session projection only after the sidecar's busy check.

## Toolset policy

`toolsets.catalog` discovers the scoped profile's plugins and MCP servers before resolving its
Agent toolsets, availability, and draft selection. Chat and catalog requests share MCP discovery,
including retirement of pre-multiplex launch connections.
`POST /api/toolsets` exposes that read-only catalog for Web and App with optional `session_id`
visibility checking. The `toolsets` body is the current draft or null for profile defaults. Clients
render `available`, `selected`, `unavailable_reason`, `selected_toolsets`, and `using_defaults`.
Unknown saved names remain visible as unavailable; an empty checklist cannot implicitly restore
broader defaults. Restoring defaults is an explicit action. The native app retains its previous
free-text editor only when an older Web server returns endpoint-not-found for the catalog.
Session-not-found, authentication, transport, server, and decoding failures retain the error state.

Both chat and manual compression forward the profile's parsed `agent.disabled_toolsets` to
`AIAgent`. The cached chat Agent identity includes this policy so changing it replaces the Agent
on the next turn. The Agent's filter also scopes deferred tool search and calls.
