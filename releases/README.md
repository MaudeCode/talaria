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
