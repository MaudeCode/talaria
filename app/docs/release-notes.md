# Release-note authoring

Run these commands from `app/`. Fragments live in `app/changelog.d/` from the
repository root. Historical fragments before the source migration remain readable
at their original root path in older commits. Byte-identical moves to `app/`
are repository-only; edits or deletions of historical fragments still fail.

Agents add release metadata with each implementation. Once the PR merges, the
signed-tag workflow does everything else: finds the preceding successful
TestFlight publication, validates the target Git tree, renders Markdown and JSON,
adds the Markdown to the workflow summary, and retains both files as the
`release-notes-X.Y.Z` artifact for 90 days. No release-time writing, sorting,
copying, LLM call, or extra credential is needed.

## Commits and PR descriptions

Use `TAL-<number>: <concrete outcome>` for every tracked commit subject and PR
title. For an approved batch, use `TAL-101, TAL-102: <shared outcome>` and add a
fragment for each ticket. In the commit body, explain the triggering problem,
the resulting behavior, and the validation when the subject alone is insufficient.

Use the PR template. Explain the user-visible outcome in **What changed**, report
commands and results in **How it was tested**, and name each fragment under
**Release notes**. For repository-only work, explain the skip reason there.
Keep implementation details in the PR; write release summaries for app users.
Commit subjects identify ticket coverage, but free-form commit and PR descriptions
are not parsed into release notes.

## Fragment format

Add `changelog.d/TAL-<number>.json`, using the selected ticket's number. Each file
contains either a non-empty `entries` array or one `skip` reason. For example:

```json
{
  "entries": [
    {
      "category": "Added",
      "summary": "Browse your boards and move cards between columns.",
      "highlight": true
    },
    {
      "category": "Fixed",
      "summary": "Chats reconnect after an interrupted response.",
      "highlight": false
    }
  ]
}
```

Categories are exactly `Added`, `Changed`, `Fixed`, and `Security`. Every entry
requires all three fields. Summaries must be non-empty, single-line plain text,
without surrounding whitespace. Use `highlight: true` for a few important
changes; these appear first under Featured and retain their category entry.
Avoid ticket numbers, commit hashes, implementation jargon, and Markdown in
summaries. The renderer escapes Markdown; the JSON preserves the authored text.

For repository, documentation, or test maintenance with no app behavior change:

```json
{"skip": "Repository tooling only; no app behavior changes."}
```

A patch touching app sources, assets, project configuration, or unclassified
paths must include user-facing entries. CI rejects missing metadata, invalid
filenames, unknown fields, duplicate JSON keys, malformed entries, and skip-only
app patches. CI also checks that each TAL key in tracked commit subjects has a
new fragment. Human review still checks that the summaries accurately describe
the changes; CI does not infer intent from code.

Fragments are append-only once merged. Edit the new fragment freely on its PR,
but preserve fragments already on the base branch. A later tracked change uses
its own ticket and fragment. Keep fragments in Git after release so historical
ranges remain reproducible.

Stage the change, then run:

```sh
python3 ci/release_notes.py validate --base origin/main
python3 ci/release_notes_test.py
```

Use the branch's merge base if `origin/main` has advanced. `validate` without
`--base` checks all working-tree fragments. CI uses `--target` to scope PR metadata
requirements to the PR head and its merge base with the fetched base branch.
It still validates every fragment in the merged test tree. Main pushes compare
against their preceding SHA. Changes already on the base branch cannot satisfy
or invalidate another PR's metadata requirement.

## Generated output

To preview a committed range locally:

```sh
python3 ci/release_notes.py generate \
  --previous v1.7.0 --target HEAD --version 1.8.0 \
  --output build/release-notes
```

For an offline preview, omit `--previous` to select the highest lower numeric
`vX.Y.Z` tag reachable from the target. This tag-only preview does not prove that
an earlier release succeeded. Non-semantic tags and tags on unmerged branches are
ignored. An explicit baseline must be an ancestor or the target itself; a repository with no prior release
tag requires `--previous <baseline-ref>`.

Production resolves the baseline automatically with `previous-published` and
passes its SHA to `generate --previous`. The resolver pages through the Release
workflow's successful runs and verifies that **Publish iOS app** succeeded.
It selects the most recent publication with a lower marketing version whose
source commit is an ancestor of the target. Failed tag validations, failed
uploads, and successful dry builds with a skipped publish job cannot consume
release notes. This uses the existing workflow token's `actions: read` access.

For tag pushes, the run's tag and SHA identify the published source, and the tag
must still match that SHA. For manual dispatches, the workflow ref can differ
from the built tag, so the resolver reads the release artifact's `sourceCommit`
and version. It stops with an error if the required publication history or manual
artifact has been deleted or expired; it never guesses from a failed tag. Older
manual artifacts are not needed once a newer eligible publication is found.

The generator reads committed blobs from the target SHA, never the working tree.
It includes only newly introduced fragments after the baseline and rejects edits,
deletions, or renames of earlier fragments. Changes without a new fragment fail
with an actionable error. A release with no changed files, including a new
marketing version on the same commit, needs no dummy commit or fragment. It
produces an empty release entry and a short no-notes statement in Markdown,
as does a range containing only explicit skips.

`release-notes.md` has a version heading and the target commit's UTC date,
Featured highlights, and non-empty categories in Added, Changed, Fixed, Security
order. Entries sort by numeric ticket number and then their authored array order.
`CHANGELOG.md` and its manually curated history stay intact.

`release-notes.json` is the versioned contract for the app's What's New work:

```json
{
  "schemaVersion": 1,
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "releases": [
    {
      "version": "1.8.0",
      "date": "2026-01-02",
      "highlights": [],
      "sections": [
        {
          "category": "Fixed",
          "entries": [
            {
              "id": "TAL-101-1",
              "ticket": "TAL-101",
              "category": "Fixed",
              "summary": "Chats reconnect after an interrupted response.",
              "highlight": false
            }
          ]
        }
      ]
    }
  ]
}
```

Each artifact contains one release. `highlights` contains the same entry objects
as the categories, ordered by ticket and authored entry order. Entry IDs are the
ticket key followed by the one-based entry index. Skip reasons are excluded from
both user-facing outputs. Bundling and presenting this catalog belong to the
separate What's New app task.

`sourceCommit` records the exact validated Git SHA and lets a later release find
the correct baseline even when this release was built through manual dispatch.

Release-note generation runs after signed-tag, ancestry, and exact-main-CI
validation and before any archive or upload. It also runs for a manual build with
`upload = false`. This workflow does not publish a GitHub Release or change the
existing TestFlight authorization gates.
