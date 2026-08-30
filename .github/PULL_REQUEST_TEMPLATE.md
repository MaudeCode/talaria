<!-- Thanks for contributing! Please read CONTRIBUTING.md before opening a PR. -->

## Linked work

<!-- Every PR must reference its canonical Kaneo task. -->

TAL-

## What changed

<!-- A short, plain-English summary of the change and why it's the right fix. -->

## How it was tested

<!-- e.g. full XCTest suite (command + result), manual simulator steps, screenshots for UI changes. -->

## Checklist

- [ ] The full test suite passes locally (`scripts/test-ios`)
- [ ] New/changed `Codable` models decode tolerantly (optionals for fields the server might add or rename)
- [ ] No new third-party dependencies (the list in `PROJECT_SPEC.md` is locked)
- [ ] No invented API endpoints or JSON shapes (verified against upstream source or a running server)
