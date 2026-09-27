# Talaria Web updates

Talaria Web keeps the **Stable** and **Experimental** update-channel choices
and the existing Update button. **Check for updates** polls at startup and every
five minutes while the server is running. **Automatically apply Web updates** is
opt-in and requires update checks to be enabled. It applies only Web updates and
retries blocked or failed attempts on the next check. Existing chats and manual cron
jobs finish first, and open embedded terminals must be closed before an update;
new chats receive a retry response while files are changing or restart is pending.
For Git source installations, Experimental follows `origin/main` through a clean Git fast-forward and needs only Git
read access. It does not query release manifests or require a release API token.
It offers updates only when the net changes under `web/` or `contracts/` differ.
Counts and change summaries include only commits touching those paths. App-only,
Relay-only, root documentation/CI/changelog-only, and fully reverted Web changes
leave Web up to date without changing its checkout or restarting it. When Web or
shared contracts do change, applying the update advances to the exact latest
main commit, including its shared history metadata.
Stable source updates follow completed releases. Stable tags are
`web-vX.Y.Z`; experimental tags are `web-exp-vX.Y.Z`. App and Relay tags cannot
become Web's version. Public Hermes WebUI imports were retired with the TypeScript backend; there is no
upstream import feed.

For Stable source updates and both packaged channels, the updater reads root releases named `release-set-<commit SHA>` and their
`release-set.json` asset. Only `status: complete` manifests with matching immutable
Web references advertise an update. A tag or draft release alone is insufficient.
The publisher must make this record public to authorized readers only after all
component gates pass. Lookup failures remain unavailable, never “up to date.”

For private release lookup, set `TALARIA_RELEASE_TOKEN` in the Web process environment
to a token with **Contents: read** on this repository. This token is separate from
Agent/provider credentials. Downloads strip authorization before following the
GitHub asset redirect. Source updates also require Git's own HTTPS credential
helper or SSH authentication; the release API token does not configure Git.
See GitHub's [release permissions](https://docs.github.com/en/rest/releases/releases#list-releases)
and [asset download API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset).

Automatic source updates require a recognized Talaria origin and the `web/`
component under the Git root. Normal clones and Git worktrees are supported.
The complete checkout must be clean, including App/Relay edits and untracked
files. Experimental source updates fetch only `origin/main`; Stable fetches the selected
published tag, checks its commit against the manifest and verifies packaged
compatibility metadata. Both paths perform
a fast-forward that protects ignored files from overwrite, then install and
build the Web packages (`npm ci` for contracts and server, `npm run build` for
each) before the release stamp is written; the supervisor re-executes the
rebuilt `packages/server/dist/bin/talaria-web.js`. A failed build reports the
npm error, keeps the previous stamp and running server, and the next Update
retries the build from the advanced source. Divergent histories
require manual reconciliation. A checkout ahead of the selected published release
is reported as manual, rather than a successful automatic update, and stays at
its current revision. At startup, an otherwise valid source stamp must match
Git HEAD; a mismatch or unreadable Git identity reports development provenance.
Packaged artifacts without Git retain their baked release identity.

Experimental source checks report the current and target Git commits. After relevant source advances,
**Finish applying this release** remains available until the server restarts with that revision.
An unchanged generated release stamp is removed when advancing to unreleased
main code; modified stamps require manual inspection. Experimental source never fabricates a
completed release identity. Switching back to Stable does not rewind a checkout
that is ahead of the published release.

Source updates advance the monorepo checkout; deployment remains component-specific.
The operation updates Web provenance and schedules a Web restart: once active work
drains and embedded terminals are closed, the server worker exits with code 75 and the
`talaria-web serve` supervisor respawns it, so the PID tracked by `ctl`, launchd,
or systemd never changes. Existing
active-run guards still apply. The compatibility `force` and `clear_lock` endpoints
use this same clean-only path for Web. Git owns its locks; the server never deletes
them. External Agent update and gateway-restart behavior stays separate. Settings
provides an independent **Update Agent** action, including when Web is current
or requires manual handling. Applying Web does not also update Agent.

**Web update channel** and **Agent update channel** are independent settings.
The existing `update_channel` remains Web-only; `agent_update_channel` defaults
to Stable and is never inherited from Web. Agent Stable selects the latest stable
upstream release tag; Experimental selects the upstream default branch. Stable
never falls back to a development branch or rewinds an ahead checkout. Agent
Experimental refreshes `origin/HEAD` from the remote using Git's native
`remote set-head --auto` after fetching. It never trusts a cached former default
or guesses a branch when that refresh fails; the check remains unavailable until
the authoritative default and its tracking ref can be resolved. Stable release
selection does not depend on this refresh. Agent
update counts are actual Git commits from the installed HEAD to the selected
target, not the number of releases. A failed count is unavailable, not zero.

Before applying an Agent revision other than the one tested with the running
Talaria release, Settings warns: "This Agent version is not officially supported
by Talaria and may cause issues." It shows the supported version/revision and
selected revision, and requires **Update anyway** to proceed. The API returns
`confirmation_required` without changing files until `confirmed_agent_revision`
matches the freshly resolved candidate. Apply, force, and lock-retry share this
check; a newly published target requires fresh confirmation. The acknowledged
immutable commit is the one installed, even if the upstream branch then moves.
The tested pin remains Talaria's official support reference. A different Agent
revision warns but can attempt operations; missing capabilities and unsafe
credential isolation still fail at use. Automatic updates still apply only to Web.

API callers can provide `agent_channel` independently of Web's `channel` on
check/apply/force requests. Omitting it uses the persisted Agent setting. Cached
checks are keyed by both channels, and old clients' `channel` remains Web-only.

Matching source alone does not complete an update. If the release stamp or
running identity is still pending, update status reports `metadata_repair: true`
while keeping the real commit distance at zero. Settings offers **Finish applying this release**
until the stamp is verified and Web restarts with that identity. Modified local
stamps require manual inspection and are not overwritten.

Direct global npm installations on Stable can update automatically. The updater
requires the package root to match the global root reported by the npm executable
beside the running Node process. It installs the exact
`@maudecode/talaria-web@<version>` recorded by the completed release manifest into
a temporary global prefix beside the running package. It verifies the version,
CLI files and baked release metadata, then renames the replacement into place.
Dependencies move with the package and the existing global CLI links keep working.
Failed installation or verification preserves the previous package. The service
user needs write access to the installation directory and room for both versions;
the updater never invokes sudo. It never follows `latest` independently.
Linked, local, npx-cache, container, mismatched-prefix, and Experimental packaged
installs remain manual. Containers use the immutable image digest from the completed
manifest. Settings distinguishes a failed check, an unknown status, local changes,
and an available automatic update; manual installations link to the releases page.

Legacy standalone checkouts require an explicit migration to an authenticated
monorepo checkout with the service working directory and launch path under `web/`.
The updater refuses to reshape an arbitrary parent repository or discard the old
checkout. Preserve the old checkout and state for rollback. No live Web host is
required to validate this distribution path.

### Prepare a legacy source migration

From an authenticated Talaria checkout, run:

```sh
python3 scripts/prepare-web-migration.py /absolute/legacy-web /absolute/new-talaria

# Track the current Git branch instead of a published release:
python3 scripts/prepare-web-migration.py /absolute/legacy-web /absolute/new-talaria --channel experimental
```

The command resolves a completed release (or `origin/main` with `--channel experimental`),
clones it into a new directory,
verifies the selected source and that the legacy revision is included in its history,
then stamps Web provenance for a published release. It copies a simple legacy `.env` with mode `0600` and
preserves its bytes. Relative paths and shell-expanded configuration require
manual review before preparation; use absolute state, workspace, Agent and TLS
paths. No state directory is copied or rewritten, and no service is started or
stopped. Keep the same service user and persistent state paths at cutover.

Preparation uses a blob-filtered partial clone and a cone-mode sparse checkout
of `web/`, `contracts/`, and `scripts/`, plus Git's root-level files. Shared commit
and tree metadata remains available; App/Relay file contents are not downloaded
or checked out. Updates preserve that configuration and suppress Git diffstat,
which would otherwise fetch excluded blobs to count changed lines. Normal sparse
clones and sparse Git worktrees are supported. Commands that explicitly inspect
excluded files can still make Git download them on demand.

Experimental preparation creates a tracking `main` branch without a release stamp;
Stable preparation checks out the selected tag's commit detached and stamps
its verified provenance. The receipt reports `updateChannel`. Select that channel
in Settings after activating the deployment; preparation does not edit existing
user settings or state. The repository already commits its frontend build, so
Git updates deliver those assets without a frontend build. The receipt lists the
`install`, `build`, and `launch` commands (`npm ci` for the contracts and server
workspaces, their builds, then the `talaria-web` bin), independently of whether
Git selected main or a release.

After preparation succeeds, stop the old service, change its working directory
and launch command to the paths in the preparation receipt, then start and check
`/health` and normal authenticated access. Preserve the legacy checkout for
rollback. An unsuccessful preparation leaves any partial new directory available
for inspection. There is no supported in-place rewrite of the standalone root.

For a legacy pip installation (`hermes-webui` or the `talaria-web` wheel), stop its
service, then install the npm package (`npm install -g @maudecode/talaria-web`) and
point the service at the `talaria-web` bin with the same `HERMES_HOME`,
`HERMES_WEBUI_STATE_DIR`, and `.env`. The Python environment can be removed once
the new service is healthy; state files are read in place without migration.
Container migrations replace only the Web image reference with the completed
manifest's digest and preserve persistent mounts.

Validation lives in `packages/server/src/tools/updates.test.ts` and the frontend
System settings/browser tests. Source tests own their repositories, tags, worktrees, locks, and state;
browser fixtures own release responses and never install updates.

## Durable update notifications

Owner sessions receive server-owned notification records for Web and Agent update attempts. The server
creates one stable record per operation, persists its lifecycle across navigation and restart, and owns
read, acknowledgement, dismissal, severity, actions, destinations, and clearability. Update records are
visible across the same owner's profiles because the installation being updated is server-wide; records
for another authenticated owner remain isolated. Automatic Web updates produce server-wide owner notices.

The notification lifecycle is `applying`, `awaiting_confirmation`, `restarting`, then `succeeded`,
`blocked`, `failed`, or `unknown`. A restarted server marks an interrupted `applying` operation unknown.
A `restarting` Web operation becomes succeeded only when the running release identity exactly matches the
persisted expected identity; otherwise it becomes unknown. A dropped connection never proves success.

`GET /api/update-notifications` returns the active owner's bounded history plus server-computed unread and
clear capabilities. The typed read, dismiss, clear, cancel, and action routes are idempotent. Clear all
preserves unresolved required acknowledgements. Opening a notification is distinct from acknowledgement;
only its explicit acknowledging action satisfies that requirement. Semantic destinations such as
`settings.system` are mapped by each client to its native route and never carry arbitrary URLs or code.

### Updating dialog

**Update Web** and **Update Agent** in Settings > System open an **Updating** dialog for the clicked target
before the request settles; the other target's action stays available. The apply request carries the tab id,
and the server records it, with the time, on the operation it starts or rejoins. Each notification read then
returns the operation that tab started or rejoined most recently as `tab_update`, including after it is dismissed
from the notification center. Automatic
updates carry no tab and never open the dialog. The dialog shows the record's phase and message, so a reload or a
route change keeps following the same operation, and a different owner never sees it.

A dropped apply response is an unknown outcome. While the read endpoint fails or the browser is offline, the
dialog keeps the last verified phase and says it is reconnecting; the 2-second poll retries, and focus or a
browser reconnection retries at once. Once the server answers, the dialog shows its record. When no record
matches, it says the outcome could not be verified and offers **Check again**, which rereads without starting
another update. The Agent confirmation dialog replaces it until **Update anyway** continues the same operation.
Closing the dialog is remembered for the tab's session, including a close made before the operation's record
arrived. A Web update that leaves the tab on an old bundle still
shows the **Refresh now** notice below.

## Stale Web tab refresh notice

Each frontend build stamps an exact identity into its shell (`<meta name="talaria-build">`, a hash of every
emitted client file, written by `finalize-dist`). An open tab sends that identity and a per-tab id
(sessionStorage, reused only when the same tab reloads, so a duplicated tab gets its own) with every notification check; the check runs with the notification
poll and again on focus, reconnect, and a service-worker takeover. The server compares the identity with
the shell it now serves and returns the result as `frontend_build`. A mismatch keeps one persistent
`web_refresh` record visible only to that tab: its **Refresh now** action reloads the tab without
acknowledging it, and read, dismiss, and Clear all cannot remove it. The server deletes the record once
the same tab reports the current identity. A matching build, a missing identity, or an unreadable shell
never creates a notice; iOS and other tabs never see it. Records of tabs that stop checking in expire
after an hour. The service worker answers navigations network-first, so a reload reaches the current
shell once the server is reachable; offline it falls back to the cached shell and the notice stays.

Packaged installations compare version numbers only within the selected channel.
Switching between stable and experimental reports a manual update with unknown
distance, even when both tags refer to the same source.
