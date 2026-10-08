# Visual references

`TalariaTests/VisualReferences/*.png` are pixel references for a small set of
core surfaces: the session row, the session-list empty state, the offline
banner, the transcript loading skeleton, composer attachment variants, the shared
status chip in each emphasis, a disabled skill row, and the
Live Activity Lock Screen plus every Dynamic Island family in the running,
waiting, stale, completed, failed and cancelled states.

`VisualReference.assertMatchesReference` renders a view with `ImageRenderer` at
2x and compares it to its reference. There is no snapshot dependency; XCTest,
SwiftUI and Core Graphics do the work.

Visual references only assert on pixels. Behaviour stays in the functional
tests — `LiveActivityTests`, `SessionListMutationTests` and their peers.

## When a reference test fails

The failure names the reference and the percentage of pixels that moved, and
attaches three images to the result bundle: `.reference`, `.rendered` and a
`.diff` that burns the changed pixels red over a grey plate. CI uploads the
result bundle as the `test-results` artifact when the suite fails, so the diff
is reviewable from the failed run.

Read the diff first. A layout or colour regression shows up as a shape; a
genuine redesign shows up as the region you just changed.

## Updating a reference on purpose

```sh
TALARIA_RECORD_VISUAL_REFERENCES=1 scripts/test-ios TalariaTests/AppScreenVisualReferenceTests
```

`scripts/test-ios` drops a `.record` marker beside the references for the length
of the run, because `xcodebuild` does not forward host environment variables
into the simulator test process. The recording run removes its marker when it ends;
a run cancelled while waiting for admission leaves it in place. The marker is
ignored by Git.

A recording run always fails: recording writes the new PNG and then reports the
reference as rewritten. Re-run without the variable to confirm the suite is
green, review the image diff in `git diff`, and commit the PNG with the change
that caused it. CI never sets the variable, so it can only report diffs.

## Keeping renders deterministic

- Every fixture is a constant. The Live Activity states pin `startedAt` and
  `updatedAt`, and the running timer reads `\.agentRunFrozenClock` instead of
  ticking, so `AgentRunElapsedTimerText` renders a fixed `02:05`.
- The session-row fixture anchors its timestamp to a whole number of days before
  the render, so the relative date reads the same on every run.
- Comparison tolerates a per-pixel channel delta of 12 across up to 0.2% of the
  image, which absorbs subpixel antialiasing between simulator runtime builds
  without hiding a moved glyph or a recoloured surface.
- Tests run under `-testLanguage en -testRegion US`, set by `scripts/test-ios`
  and by CI. SwiftUI's `\.locale` environment does not reach Foundation
  formatters, so `RelativeDateTimeFormatter`, `ByteCountFormatter` and
  `String(localized:)` would otherwise follow whatever language the simulator
  happens to be set to.
- Sizes are fixed per reference. If content grows past its frame it is clipped
  rather than resized, so give a new reference a frame with room to spare.

## Why the Live Activity views build into the app

`ActivityViewContext` can only be created by the system, so the Lock Screen view
takes a `ContentState` and the widget passes `context.state` in. The Live
Activity view files are members of the app target as well as the widget target
— the same arrangement `AgentRunActivityAttributes.swift` already uses — so the
unit test bundle reaches them through `@testable import Talaria` instead of
carrying a second copy of the model.

## Adding a reference

Add the case to `LiveActivityVisualReferenceTests` or
`AppScreenVisualReferenceTests`, record it, and commit the PNG. A view that
needs a live view model, a network response, or a `ScrollView` layout pass is
not a candidate — `ImageRenderer` draws scrolling content empty. Render the rows
the state is made of instead, the way the transcript loading reference does.
