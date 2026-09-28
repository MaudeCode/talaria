## Linked work

<!-- Every PR must reference its canonical Kaneo task. -->

TAL-

## What changed

<!-- A short, plain-English summary of the change and why it's the right fix. -->

## How it was tested

<!-- e.g. full XCTest suite (command + result), manual simulator steps, screenshots for UI changes. -->

## Release notes

<!-- Add changelog.d/TAL-<number>.json for each ticket. State its path and the
user-visible outcome, or its explicit repository-only skip reason. Follow
app/docs/release-notes.md; CI validates the fragments, not this prose. -->

## Checklist

- [ ] Release fragments validate (`python3 app/ci/release_notes.py validate --base origin/main` after staging)
- [ ] Affected component checks pass locally (`scripts/check app|web|relay|contracts|docker`)
- [ ] New/changed `Codable` models decode tolerantly (optionals for fields the server might add or rename)
- [ ] No new third-party dependencies without approval
- [ ] No invented API endpoints or JSON shapes (defined in `web/packages/contracts` or verified against a running server)
