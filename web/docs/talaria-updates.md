# Talaria Web updates

Talaria Web follows completed releases from `MaudeCode/talaria`. Stable tags are
`web-vX.Y.Z`; experimental tags are `web-exp-vX.Y.Z`. App and Relay tags cannot
become Web's version. Public Hermes WebUI imports remain a maintainer operation
through root `scripts/import-web-upstream`; they are not an end-user update feed.

The updater reads root releases named `release-set-<commit SHA>` and their
`release-set.json` asset. Only `status: complete` manifests with matching immutable
Web references advertise an update. A tag or draft release alone is insufficient.
The publisher must make this record public to authorized readers only after all
component gates pass. Lookup failures remain unavailable, never “up to date.”

For a private repository, set `TALARIA_RELEASE_TOKEN` in the Web process environment
to a token with **Contents: read** on this repository. This token is separate from
Agent/provider credentials. Downloads strip authorization before following the
GitHub asset redirect. Source updates also require Git's own HTTPS credential
helper or SSH authentication; the release API token does not configure Git.
See GitHub's [release permissions](https://docs.github.com/en/rest/releases/releases#list-releases)
and [asset download API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset).

Automatic source updates require a recognized Talaria origin and the `web/`
component under the Git root. Normal clones and Git worktrees are supported.
The complete checkout must be clean, including App/Relay edits and untracked
files. The updater fetches only the selected published tag, checks its commit
against the manifest, verifies its packaged compatibility metadata, and performs
a fast-forward that protects ignored files from overwrite. Divergent histories
require manual reconciliation. An installation already containing the selected
release stays at its current revision.

Source updates advance the monorepo checkout; deployment remains component-specific.
The operation stamps the new Web provenance and schedules a Web restart. Existing
active-run guards still apply. The compatibility `force` and `clear_lock` endpoints
use this same clean-only path for Web. Git owns its locks; the server never deletes
them. External Agent update and gateway-restart behavior stays separate.

Containers and wheels use manual artifact replacement, with the image digest or
source/build identity from the completed manifest. Settings distinguishes a
failed check, an unknown status, local changes, and an available automatic update.
Manual installations link to the Talaria releases page. Keep persistent state and
the previous immutable artifact when replacing an installation.

Legacy standalone checkouts require an explicit migration to an authenticated
monorepo checkout with the service working directory and launch path under `web/`.
The updater refuses to reshape an arbitrary parent repository or discard the old
checkout. Preserve the old checkout and state for rollback. No live Web host is
required to validate this distribution path.

### Prepare a legacy source migration

From an authenticated Talaria checkout, run:

```sh
python3 scripts/prepare-web-migration.py /absolute/legacy-web /absolute/new-talaria
```

The command resolves a completed release, clones it into a new directory,
verifies the tag/source and that the legacy revision is included in its history,
then stamps Web provenance. It copies a simple legacy `.env` with mode `0600` and
preserves its bytes. Relative paths and shell-expanded configuration require
manual review before preparation; use absolute state, workspace, Agent and TLS
paths. No state directory is copied or rewritten, and no service is started or
stopped. Keep the same service user and persistent state paths at cutover.

After preparation succeeds, stop the old service, change its working directory
and launch command to the paths in the preparation receipt, then start and check
`/health` and normal authenticated access. Preserve the legacy checkout for
rollback. An unsuccessful preparation leaves any partial new directory available
for inspection. There is no supported in-place rewrite of the standalone root.

For a legacy pip installation, stop its service, uninstall the `hermes-webui`
distribution from that environment **before** installing the released
`talaria-web` wheel. Both distributions contain the same top-level runtime module
names, so concurrent installation is unsupported. The new wheel supplies both
`talaria-web` and the legacy `hermes-webui` command; preserve the environment and
state settings when restarting. Container migrations replace only the Web image
reference with the completed manifest's digest and preserve persistent mounts.

Validation lives in `tests/test_tal203_source_update.py`,
`tests/test_tal203_published_releases.py`, and the frontend System settings/browser
tests. Source tests own their repositories, tags, worktrees, locks, and state;
browser fixtures own release responses and never install updates.
