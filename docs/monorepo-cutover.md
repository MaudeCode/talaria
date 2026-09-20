# Production cutover

TAL-204 completes the source migration and release integration recorded in
[the migration guide](monorepo-migration.md). The first completed release set, rollback rehearsal, and standalone archival
are recorded below.

## Source and active work

The first component release set uses
`950f692391a8c00f7687f91dd6db25cf6fa14b91`:

| Component | Signed tag | Preserved standalone runtime source |
|---|---|---|
| App | `app-v1.9.0` | Existing Talaria history |
| Web | `web-v1.0.0` | `01e1582dd8abd87a7f1020e8a930b69466cd0cf6` |
| Relay | `relay-v0.2.0` | `0263205690d8448c075c74e894fa8632c7c7a8b4` |

All thirteen original Relay tag objects and the existing App tags remain
available. The unmerged Web branch at
`0142e21701a00bf7482a5e2c4c96e91582f41dff` is retained under the immutable tag
`legacy/hermes-webui/webhook-sidebar-filter`. Dirty worktrees were left intact;
private patches and the worktree inventory remain in task-owned local storage.
No open standalone PR remains. Talaria PRs #87 and #89 stay in the canonical
repository and are outside this cutover. The factory scheduler remains disabled.

Open legacy tracker work moved into Talaria with its original IDs and scope
labels; completed history remains in the legacy projects. Scope labels are
`app`, `web`, `relay`, `tooling`, and `contracts`. CI selection uses changed
paths, independently of tracker labels. Repository instructions and the local
shared tracker skill follow this routing; the shared skill was not published
as a separate package release.

## Existing identities and state

The signed device build was installed over the existing `dev.kil.talaria` App.
The user confirmed retained accounts, servers, preferences, cached chats,
widgets, and share-extension state. The release IPA remains App 1.9.0 build 1:

`sha256:0b0872dd598013b1bca2fbd0f4125348fe8f590a0219f8b0e364150894ccd227`

Relay remains on Convex deployment `terrific-bloodhound-879`, using
`https://relay.talaria.kil.dev`, its existing APNs configuration, and its existing
users, devices, publishers, keys, grants, and sessions. Deployment readback
retained all recorded identity IDs. The user confirmed Live Activity delivery;
recent alert-bearing Live Activity updates received APNs HTTP 200. Relay
intentionally omits a separate notification for a device already alerted through
its Live Activity. A separate notification banner was not independently confirmed.

There is no live Web installation to migrate. Web validation therefore uses a
synthetic standalone source installation with persistent profile/session and
configuration fixtures, without provisioning a service or changing a host.

## Release evidence

- [Root rehearsal](https://github.com/MaudeCode/talaria/actions/runs/35486245823)
  passed current/previous App contracts, Agent compatibility, and component builds.
- [Existing-target rehearsal](https://github.com/MaudeCode/talaria/actions/runs/35495464314)
  passed against the selected production deployment identity.
- [Original publication](https://github.com/MaudeCode/talaria/actions/runs/35501070320)
  deployed Relay and published Web. Apple returned valid IPA chunks out of order;
  upload stopped before completing transfer.
- [Read-only Apple inspection](https://github.com/MaudeCode/talaria/actions/runs/35513506038)
  established that the existing upload/file remained awaiting transfer.
- [Recovery](https://github.com/MaudeCode/talaria/actions/runs/35517658223)
  confirmed App 1.9.0 build 1 as `VALID`; its final readback passed on attempt 2.
  It consumed authenticated original job outputs and retained artifact hashes,
  preserving the original IPA, tags, and successful receipts. New upload evidence
  records the actual recovery run rather than claiming the original run succeeded.
  GitHub requires workflow-write permission to publish against an older workflow
  tree, which the built-in Actions token lacks. The prepared releases were
  therefore published through the existing operator login, without adding
  credentials or changing access settings. The same workflow then verified the
  exact published manifest and asset hashes.

The published Web image is
`ghcr.io/maudecode/talaria-web@sha256:233220cef4cc30e7769508767d76f249bf3dc69d76dd4a2b93b8b74d694078dc`.
The [completed root manifest](https://github.com/MaudeCode/talaria/releases/tag/release-set-950f692391a8c00f7687f91dd6db25cf6fa14b91)
is published and remains the updater's publication boundary.

## CI and repository controls

Release jobs use self-hosted runners and retain handoffs locally; no Actions
budget increase was made. Apple, Relay, Web registry, and root publication jobs
keep their separate environment/credential boundaries. Production environments
are restricted to main. Namespaced component tags and release-set tags are
protected against changes, alongside historical tags. The old standalone
publication workflows were disabled before monorepo publication.

The maintainer explicitly excluded further general GitHub App/access inventory;
existing integrations were retained. Cutover changes were confined to the
required workflow environments, branch policies, tag protection and retirement.

## Upgrade and rollback proof

The published Web release upgraded an isolated checkout of the recorded
standalone revision. All four synthetic profile/session/settings/auth-binding
fixtures and the exact environment bytes were retained; the new environment
file remained mode 0600. The original checkout and configuration remained
unchanged as the rollback source. No live Web host was provisioned or migrated.

Relay was redeployed from `0263205690d8448c075c74e894fa8632c7c7a8b4` into the
same existing Convex deployment, then restored to the stamped `0.2.0` source
`950f692391a8c00f7687f91dd6db25cf6fa14b91`. Both health checks passed. Snapshot
comparisons retained every existing ID: two users, two devices, two publishers,
four publisher keys, one grant, and two user sessions. The schema was byte
identical, and no data import/reset or replacement project was used. Current
and previous App contract gates cover the unchanged protocol boundary.

The rehearsal used clean task-owned checkouts and the existing deployment-scoped
key in a private temporary env file. From the selected Relay checkout, the
exact deployment command was:

```sh
node node_modules/convex/bin/main.js deploy --yes --env-file "$PRIVATE_RELAY_ENV"
```

The restoration checkout's `convex/releaseInfo.json` was stamped with the
recorded version, source/release-set SHA, deployment ID and contracts before
that command. Each deployment was followed by `/v1/health` and a private Convex
snapshot comparison. The final health reports the intended `0.2.0` release.
Production redeployment remains an explicit human gate.

## Standalone retirement

Both repositories have final signed README notices pointing to the owning
monorepo directory, and both are archived:

| Repository | Final preserved head | Inactive workflows |
|---|---|---|
| `MaudeCode/hermes-webui` | `9ae0c242c7eea49bf5ea4cf5d262fdebcf0fe786` | 5 |
| `MaudeCode/talaria-relay` | `0366e539ab05943c3d1132ccf2a00bf613a23cd3` | 2 |

Archival prevents new writes, issues and pull requests while preserving history,
tags, releases, URLs and attribution. Both final heads are retained as ancestry
of the completion change using intentional `ours` merges; their standalone root
trees are not reapplied over the monorepo. Talaria is the only writable canonical
repository. The private evidence bundle retains snapshots, artifact digests,
API readbacks and preserved worktree patches; none contains tracked credentials.
