# Release-set metadata

`release-set.schema.json` defines version 1 of the immutable release receipt.
Its identifier is the monorepo source SHA. Each changed component is built from
that SHA; an unchanged component retains its previous tag, artifact, source and
original release-set identifier. Versions are independent. Supported contract
versions are explicit capability sets; peers must share a capability, and the
new servers must still support the previously released App.

`release_set.py MANIFEST --previous PREVIOUS --output DESTINATION` validates the
schema and cross-field rules before writing a new file. Omit `--previous` only
for the first release set. Existing output files are never overwritten. The
previous document must come from the trusted completed-release publication.

A `candidate` records the intended App build number, locally built Web image
digest and Relay deployment target. It cannot claim a new Relay deployment or
any publication receipt. A `complete` document additionally requires successful
publication evidence for every changed component and the actual deployed Relay
revision. Unchanged components are not republished. Failed or partial runs must
remain diagnostics; changing `status` alone cannot complete them.

Evidence records identify successful workflow gates and their exact source.
JSON validation checks consistency, not whether a remote job actually ran.
Only the trusted root workflow may assemble and publish the completed receipt
from its own successful jobs. Never use an operator-authored JSON receipt as
authorization to deploy or upload.

The Web image digest is the registry manifest digest, not a mutable tag or Docker
config/image ID. Agent identity contains its exact version and immutable source
SHA or published image digest (or both). It is an external dependency, not a
fourth component. The App marketing version and build number, Web image digest,
and Relay source/deployment identity are the rollback inputs.

Run `scripts/check-releases` for isolated synthetic validation. It installs the
pinned release-tool dependencies in a disposable virtual environment and
requires no accounts, credentials, tags or running services.

The Web updater's publication contract is a GitHub release named
`release-set-<releaseSet SHA>` with a `release-set.json` asset. Prepare it as a
draft; publication of the completed manifest is the final step after component
build, compatibility and publication receipts succeed. Never replace a published
manifest. Component notes and signed tags keep their own App/Web/Relay namespaces.
See [Web update behavior](../web/docs/talaria-updates.md) for authentication and
source-install safety boundaries.

Release jobs run on the existing `maude-mac` self-hosted runner. Build handoffs
stay under its `~/.local/share/talaria-release-runs/<run>/<attempt>/` directory;
there are no GitHub Actions artifact uploads. Producer jobs record content
digests in GitHub job outputs. Consumers verify those digests, the workflow
source, run and runner identity before restoring files. Keep the `maude-mac`
label assigned to this single runner; a different runner cannot consume its
handoffs.

Successful final jobs retain the manifest and sanitized contract diagnostics,
then remove large build handoffs from all attempts of that run. The manifest is
also printed in the final job log and summary. Failed runs retain their local
files for inspection and same-run retries. After preserving required failure
evidence, the runner owner may remove that specific run directory. Each
component still has a separate environment and job token. No spending-budget
change is required.

## Workflow commands

`cli.py prepare` checks exact-main CI, resolves component tags, generates notes,
and records the previous published App source. Its request contains only
`sourceRevision`, `tags` (App/Web/Relay), and `relayDeploymentId`. A previous
manifest is downloaded with `cli.py previous SHA`; drafts and inconsistent
identities are rejected. Unchanged components retain their complete prior
records and compatibility metadata.

Preparation in dry-run mode may create ephemeral signed tags in a disposable
local clone. These signatures validate the rehearsal only. Production requires
the existing tags' GitHub-verified signatures. Neither mode pushes tags.

`build.py COMPONENT --plan PLAN --output NEW_DIRECTORY` builds without publishing:
an unsigned App archive with verified bundle versions, a Web wheel and
multi-platform OCI archive, or checked Relay functions validated against an
anonymous local backend. Use an output directory outside the source checkout.
Local execution writes `build-result.json`; Actions execution additionally writes
a receipt tied to the actual run. An unsigned App archive is not an installable
device-validation build.

`cli.py gate` writes a success receipt only after its supplied validation command
succeeds. `cli.py assemble` combines receipts and notes; failed/missing gates,
changed artifact identities, and attempted completion of dry-run plans fail.

For previous-App verification, root `scripts/check-previous-app.py --app-ref REF
--web-ref REF --output NEW_DIRECTORY` starts the selected Web in isolated state,
exports live responses, and compiles the actual older App from Git. It verifies
the fixtures reached the test bundle and retains structured XCTest results.

## Root workflow

Component-tag pushes run read-only validation. Production starts only through
`production-cutover.yml` on `main`; direct `release-set.yml` dispatches support
dry runs. Both take a JSON `request` with this shape:

```json
{
  "sourceRevision": "<40-character main commit SHA>",
  "tags": {"app": "app-v1.9.0", "web": "web-v1.0.0", "relay": "relay-v0.2.0"},
  "relayDeploymentId": "<existing production deployment ID>"
}
```

These are illustrative versions, not a release selection. Supply
`previous_release_set` as the last completed set's SHA; leave it empty only for
bootstrap. Preparation checks all published root releases and rejects a missing
or stale predecessor once a release set exists. Changed tags must point to
`sourceRevision`; unchanged tags must match the previous manifest. Production
requires pushed, verified signed tags.

First dispatch `release-set.yml` with `dry_run=true`. Require the candidate
artifact and successful selected-source contracts, previous-App contracts,
pinned Agent compatibility and component builds. The dry run uses no component
publication credentials. It creates neither registry images nor GitHub releases.

With publication authorized, dispatch `production-cutover.yml` on `main` using
the same request and `confirm_publication=true`. It repeats the gates, builds
all changed artifacts, then deploys Relay, publishes Web and uploads App in
that order. Unchanged components skip their build/publication jobs. Required
jobs that fail, cancel or unexpectedly skip block completion.

Credentials are scoped to jobs: `relay-production` supplies the matching
production deployment key, `web-release` uses the job's package-write token,
`testflight` supplies Apple signing/upload credentials, and
`release-set-publication` grants the job's release-write token. Configure these
environments to allow the trusted `main` workflow before the first cutover.
There is no live Web host in this migration; Web publication is followed by
isolated legacy-upgrade validation, not host provisioning.

The root manifest is published last. If a run fails after a deployment, upload
or component release, inspect those side effects before retrying. Existing
release names are rejected, including drafts. Never overwrite a completed
manifest or describe a partial run as a completed release. Retain the previous
manifest's component identities for rollback.
