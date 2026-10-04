# Talaria Web updates

Talaria Web keeps the **Stable** and **Experimental** update-channel choices
and the existing Update button. **Check for updates** polls at startup and every
five minutes while the server is running. **Automatically apply Web updates** is
opt-in and requires update checks to be enabled. It applies only Web updates and
retries blocked or failed attempts on the next check. Existing chats and manual cron
jobs finish first, and open embedded terminals must be closed before an update;
new chats receive a retry response while files are changing or restart is pending.
Only a direct global npm installation (`npm install -g @maudecode/talaria-web`) updates itself. Stable installs the
exact package in the newest completed release set; Experimental installs the verified artifact that CI publishes to
`ghcr.io/maudecode/talaria-web-experimental` for each passing `main` commit that changes Web or shared contracts.
Changing the channel switches the installation on its next update, in either direction, after backing up the
persisted stores.

A source checkout is for contributors. The updater reports it as a manual update with a server-owned message and
never fetches, merges, rebuilds or restamps it: update it with `git pull`, then `npm ci` and `npm run build:fast`
(see the README). The frontend bundle in `static/dist/` is built, not committed, so a checkout that skips the build
has no UI.

Stable tags are
`web-vX.Y.Z`; experimental tags are `web-exp-vX.Y.Z`. App and Relay tags cannot
become Web's version. Public Hermes WebUI imports were retired with the TypeScript backend; there is no
upstream import feed.

For Stable, the updater reads root releases named `release-set-<commit SHA>` and their
`release-set.json` asset. Only `status: complete` manifests with matching immutable
Web references advertise an update. A tag or draft release alone is insufficient.
The publisher must make this record public to authorized readers only after all
component gates pass. Lookup failures remain unavailable, never “up to date.”

For private release lookup, set `TALARIA_RELEASE_TOKEN` in the Web process environment
to a token with **Contents: read** on this repository. This token is separate from
Agent/provider credentials. Downloads strip authorization before following the
GitHub asset redirect.
See GitHub's [release permissions](https://docs.github.com/en/rest/releases/releases#list-releases)
and [asset download API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset).

An npm update stages the new package beside the installed one, verifies its name, bins and release identity,
and swaps it in only if the update settings are unchanged; any failure keeps the installed package. It then
schedules a Web restart: once active work
drains and embedded terminals are closed, the server worker exits with code 75 and the
`talaria-web serve` supervisor respawns it, so the PID tracked by `ctl`, launchd,
or systemd never changes. Existing
active-run guards still apply. The compatibility `force` and `clear_lock` endpoints
use this same path for Web, so they never mutate a source checkout. Git owns its locks; the server never deletes
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

**Update Agent** keeps tracked local edits in the Agent checkout. It saves them
with `git stash create` under a private `refs/talaria/autostash/<sha>` ref, never
the shared stash list, and reverts exactly that patch before fast-forwarding.
Afterwards it re-applies the patch with `git apply`, which writes all of it or
nothing. If the edits conflict with the update, the Agent files stay as the
update wrote them, with no conflict markers. The saved commit stays under its
private ref, which the user deletes once satisfied. It is also listed in
`git stash list` for convenience. The result carries `stash_conflict: true`
with inspect, re-apply, and cleanup commands. An
edit made while the update saves local changes aborts the update; nothing is
lost. While an update runs, the saved commit lives under
`refs/talaria/autostash/pending/<sha>`. If the server stops before restoring it,
the next Agent check or update finishes the job: changes already in the tree
just drop the ref, and the rest are re-applied or kept and listed as above.

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
On Experimental, a direct global npm installation follows the public
`ghcr.io/maudecode/talaria-web-experimental:experimental` artifact with no token. The
updater requests an anonymous pull token and reads the manifest. It requires the
Experimental artifact type, one npm tarball layer, and revision and version
annotations. It downloads the layer only through GHCR's redirect to
`pkg-containers.githubusercontent.com` without the token, and requires the bytes to
match the layer digest. The installation is behind when its release `sourceRevision`
differs from the annotated revision. The tarball installs into the same staged
prefix, and its baked `_release.json` must match the annotations before the rename.

Changing the channel switches an npm installation on its next update, in either
direction. A switch installs the selected channel's newest artifact regardless of
version order; within Stable the "ahead of the selected release" guard still applies.
Before a switch replaces the package, the updater copies `settings.json`,
`projects.json`, `workspaces.json`, and `last_workspace.txt` from the Web state
directory to `backups/channel-switch-<UTC timestamp>/`, keeping the newest five.
If that backup fails, the switch is aborted and the installed package is kept.

Linked, local, npx-cache, container, and mismatched-prefix packaged installs remain
manual. Containers use the immutable image digest from the completed
manifest. Settings distinguishes a failed check, an unknown status, local changes,
and an available automatic update; manual installations link to the releases page.

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
`blocked`, `failed`, or `unknown`. A failed or blocked record, and a succeeded Agent update that kept conflicting local edits in the git stash (`stash_conflict`), keeps the apply's own explanation as `detail` (line breaks kept, bounded, cleared by the next phase); the notification center and the Updating dialog show it under the message. A restarted server marks an interrupted `applying` operation unknown.
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
from the notification center, and when the tab last joined it as `tab_joined_at`. A rejoin whose response is lost
changes only that time, so the dialog still recognizes its operation. Automatic
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
