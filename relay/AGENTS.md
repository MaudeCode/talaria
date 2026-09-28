# Talaria Relay instructions

Follow `../AGENTS.md`. Run Relay commands from `relay/`. Read
`docs/http-api.md` for HTTP, enrollment, publisher, device, and ActivityKit changes.
Use existing Convex validators, indexes, auth checks, and test helpers.
Run `pnpm check`; `convex-test` validates functions against the actual schema
in isolated synthetic state. Local Convex validation must use a fresh anonymous
local deployment, never an existing production deployment or database.

Relay credentials belong only to its deployment workflow. Never replace the
production deployment, database, domain, APNs configuration, publisher
registrations, or device records.
