# Release-note authoring

Agents add release metadata with each implementation. Once the PR merges, the
signed-tag workflow does everything else: selects the preceding reachable
semantic release tag, validates the target Git tree, renders Markdown and JSON,
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
`--base` checks all working-tree fragments. The CI workflow checks the PR merge
base or the main push's preceding SHA and always validates every fragment.

## Generated output

To preview a committed range locally:

```sh
python3 ci/release_notes.py generate \
  --previous v1.7.0 --target HEAD --version 1.8.0 \
  --output build/release-notes
```

Omit `--previous` to select the highest lower numeric `vX.Y.Z` tag reachable from
the target. Non-semantic tags and tags on unmerged branches are ignored. An
explicit baseline must be a strict ancestor; a repository with no prior release
tag requires `--previous <baseline-ref>`. Normal signed releases already have a
preceding semantic tag and need no input beyond the release tag.

The generator reads committed blobs from the target SHA, never the working tree.
It includes only newly introduced fragments after the baseline and rejects edits,
deletions, or renames of earlier fragments. An empty range fails with an actionable
error; a range containing only explicit skips produces an empty release entry
and a short no-notes statement in Markdown.

`release-notes.md` has a version heading and the target commit's UTC date,
Featured highlights, and non-empty categories in Added, Changed, Fixed, Security
order. Entries sort by numeric ticket number and then their authored array order.
`CHANGELOG.md` and its manually curated history stay intact.

`release-notes.json` is the versioned contract for the app's What's New work:

```json
{
  "schemaVersion": 1,
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

Release-note generation runs after signed-tag, ancestry, and exact-main-CI
validation and before any archive or upload. It also runs for a manual build with
`upload = false`. This workflow does not publish a GitHub Release or change the
existing TestFlight authorization gates.
