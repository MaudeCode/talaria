---
name: talaria-release
description: Publish a Talaria release set including TestFlight when the user requests a production release; validate signed component tags without treating a tag push as publication.
---

# Talaria release

Run release orchestration from the repository root. Read
[`releases/README.md`](../../../releases/README.md) for the request format,
workflow dispatches, environment boundaries and partial-failure handling.

1. Select a clean, current `main` source with successful exact-SHA CI. Resolve
   the previous completed release set and identify changed components. Reuse
   unchanged component tags exactly.
2. Create signed namespaced tags for changed components at the selected source
   and push them within the user's authorization. Confirm the validation-only
   tag workflow succeeds.
3. Dispatch `release-set.yml` with `dry_run=true` and the reviewed request.
   Require successful compatibility/build jobs and a candidate manifest matching
   the selected source, tags and previous set.
4. With production publication authorized, dispatch `production-cutover.yml`
   from `main` with the same request and `confirm_publication=true`. Report
   Relay readback, Web digest publication, App archive/upload/processing and
   completed root manifest separately. A failed or partial run is incomplete;
   inspect its side effects before retrying.

App Store Connect supplies the next build number. Repository version fields
remain development defaults. External tester assignment, Beta App Review,
agreements and compliance prompts remain owner actions in App Store Connect.
