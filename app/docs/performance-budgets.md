# Performance budgets

The measurements that guard Talaria's slowest user-visible paths (TAL-75), the
baselines the thresholds came from, and how to compare a run against them.

## Where each budget lives

Every budget measures an algorithm in `TalariaTests`, where the numbers are
stable enough to assert on, and runs in the hosted tests on the `main` push
that introduces a regression. Launch, transcript scrolling, navigation and the
sidebar are checked on a device against the release phone list
(`docs/phone-checks.md`), in Instruments when a change touches them.

| Budget | Test |
| --- | --- |
| Streaming replay catch-up scaling | `TalariaTests/ReplayCatchUpPerformanceTests` |
| Dense Kanban load and filter | `TalariaTests/KanbanBoardPerformanceTests` |
| Large image preview preparation | `TalariaTests/ImagePreviewPerformanceTests` |
| Chat stream tick and keystroke | `TalariaTests/ChatStreamTickPerformanceTests` |
| Chat open scaling | `TalariaTests/ChatOpenPerformanceTests` |

## Fixture data

Every budget measures fixed content, so two runs differ only in the code under
them.

- The Kanban budget decodes a generated 1,200-card Board across six columns.
- The image budget encodes a deterministic 4032x3024 tile pattern as JPEG.
- The chat stream tick budget hosts the chat over 100 generated turns (200
  messages; every fifth reply carries reasoning and every fifth, offset by two,
  a fenced code block), streams a reply that opens, fills and closes a Swift
  code block, ends the reply, then types into the composer. Typing waits for
  the reply to end: a live stream silent for 12 s starts a stale-stream check,
  which would make keystroke counts depend on the host's speed.
- The chat open budget loads one page of 200 or 600 generated messages:
  user and assistant alternate, and each carries Markdown with a code span and
  a link. The load measurement reopens a chat whose transcript is already
  cached; the hosted measurement opens an uncached `ChatView` and waits for the
  last row's label.
- The replay budget streams generated tokens, replays them over a scripted
  reconnect, and checks the resulting transcript on every run so a broken dedup
  cannot pass as a fast one.

## Hardware and runtime

Every number below was measured on:

- Apple silicon host, `scripts/test-ios` against the shared simulator pool
- iPhone 17 Pro simulator, iOS 26.4.1 (build 23E254a), arm64
- Debug configuration, three iterations per metric

Simulator numbers are for comparison against other simulator numbers. They are
not device timings, and thresholds are set with headroom for a loaded CI host
rather than at the observed value.

## Baselines

Medians of three iterations.

| Measurement | Median | Spread |
| --- | --- | --- |
| Replay catch-up, 4,000 tokens (clock) | 0.009 s | 0.000 s |
| Replay catch-up, 4,000 tokens (peak memory) | 53,447 kB | 16 kB |
| Chat, 200 stream ticks and 200 keystrokes (clock) | 10.10 s | 0.05 s |
| Chat, 200 stream ticks and 200 keystrokes (CPU) | 9.54 s | 0.09 s |
| Chat reopen, 600 cached messages (clock, fastest of 5) | 138 ms | |
| Hosted chat open, 600 messages (clock, fastest of 3) | 519 ms | |

The chat budget was measured on an iOS simulator inside the local macOS build VM
rather than the pool above. Ticks took 8.0-8.1 s (~40 ms each) and
keystrokes 1.5-1.7 s (~8 ms each). GitHub's hosted runner measures about
four times slower; the work counts match.

The chat open budget was also measured in the build VM, on an iPhone 18 Pro
simulator running iOS 27.2.

The replay, chat and chat open budgets assert thresholds; the others record for comparison.

- Replay catch-up may not cost more than 8x across the curve's 4x span, and
  4,000 tokens may not take more than 80 ms. A linear path measures ~3.9x and
  ~8.7 ms; the quadratic path this replaced measured ~16x and 212 ms. The
  endpoints are compared rather than each step because at these millisecond
  scales one noisy middle sample decides a per-step ratio.

- The chat's 400 operations may not take more than 180 s: over 3x the 47-53 s
  GitHub's hosted runner measured before TAL-852, and ~18x the build VM.
  Its work counts below are the real gate: each count's minimum across runs is
  asserted exactly.

- Chat open may not cost more per message at 600 messages than twice its cost
  at 200, in both measurements. The reopen of 600 messages may not take more
  than 1 s and the hosted open more than 5 s: about 7x and 10x the build VM, for
  a runner about four times slower.

## Chat stream tick and keystroke work

`ChatBodyEvaluationRecorder` (DEBUG builds only) counts the main-thread work
each operation repeats. Every tick and keystroke is rendered and its queued
main-actor work run until the counted work stays unchanged for three hops,
without waiting on a clock. Work an
operation causes recurs in every run, while an unrelated timer-driven update
lands in at most one, so the test asserts each count's minimum across runs.

| Work | 200 stream ticks | 200 keystrokes |
| --- | --- | --- |
| Reasoning-card derivation | 200 | 4 |
| Streaming Markdown split | 200 | 0 |
| Code highlighting | 0 | 0 |
| Message list body | 200 | 4 |
| Settled transcript row body | 0 | 0 |
| Settled message bubble body | 0 | 0 |
| Whole chat body | 0 | 4 |
| Toolbar body | 0 | 4 |
| Composer body | 0 | 212 |

A tick splits the streaming reply once (TAL-853). Code blocks highlight on their own
thread and settled results are cached, so no highlighting reaches the main thread (TAL-854;
it counted 100 before). A keystroke re-evaluates only the
composer; the chat's four passes follow the composer's height as the draft
wraps. A change that removes a repeat lowers its count in the test and here.

## Replay catch-up: the measured change

Replay token dedup rebuilt `flushedContent + pendingAssistantTokenText` and
traversed it for every replayed token, so catching up after a reconnect cost
O(response²) on the main actor.

| Tokens | Response | Before | After |
| --- | --- | --- | --- |
| 1,000 | 7,590 chars | 14.0 ms | 2.3 ms |
| 2,000 | 15,172 chars | 54.7 ms | 4.4 ms |
| 4,000 | 30,340 chars | 212.4 ms | 8.7 ms |
| growth per doubling | | ~3.9x | ~1.96x |

`ChatViewModel` now caches the unmatched tail of the received text while an
armed replay keeps matching in order, keyed on the received UTF-8 length so any
other rewrite of the streaming message falls back to the exact comparison.

## Chat open: the measured change

A load with a cache merges the server's page with the cached transcript, so a
reload's own steering and optimistic rows survive and missing activity is
filled in. The merge looked up each assistant reply's cached copy by scanning
the whole cache, so reopening a long cached chat, and every reload after a run
finished, cost O(messages²) on the main actor. It now builds one lookup per
merge (TAL-1678). `ChatViewModelMergeDedupTests` asserts the merge's growth
across 1,000 to 4,000 messages, where the scan measured 16.0x and the lookup
measures 4.0x.

All measured in one session in the build VM on the iPhone 18 Pro simulator,
iOS 27.2, fastest run per size:

| Commit | Reopen 200 | Reopen 600 | Per message, 200 to 600 | Hosted open 200 | Hosted open 600 |
| --- | --- | --- | --- | --- | --- |
| `1bf0c1fd5` | 46.3 ms | 168.0 ms | 1.21x | 514 ms | 876 ms |
| `547de77cb`, before | 53.0 ms | 188.9 ms | 1.19x | 452 ms | 607 ms |
| After | 46.9 ms | 138.0 ms | 0.98x | 310 ms | 519 ms |

The hosted open waits for the last row with a 50 ms poll, so its fixed cost
dominates at these sizes: it costs less per message at 600 than at 200 on every
commit. The 3.4 s for 600 messages that prompted this budget was measured on an
iPhone 17 Pro simulator running iOS 27.0 and did not recur in the build VM.

## Chat open: serial round trips to a ready composer

`ChatViewModelSendTests/testChatOpenSendsTheTranscriptBeforeItAppearsAndReachesAReadyComposerInFourRoundTrips`
holds every request and answers them one round trip at a time, so requests
sent together share a round trip and requests that wait for one another take
one each. It opens an uncached chat the way `ChatView` does and counts the
round trips until the composer's controls and approval state are loaded
(TAL-839).

| | Before the appearance completes | After it, to a ready composer |
| --- | --- | --- |
| Before | nothing | 8: transcript, background work, profiles, models, reasoning, workspaces, commands, approval |
| After | transcript | 4: background work, profiles with approval, models with workspaces and commands, reasoning |

A session on another profile adds one round trip, the profile switch, after
the profiles in both. Models and workspaces are profile-scoped, so the switch
settles first; reasoning is scoped to the resolved model, so it follows the
models. The prefetched transcript applies only once the chat has appeared.

## Comparing a run

Every CI run uploads a `performance-metrics` artifact (`performance-metrics.json`
and a readable `performance-metrics.txt`) and prints the same table into the job
summary. Locally:

```zsh
scripts/test-ios TalariaTests/ReplayCatchUpPerformanceTests
xcrun xcresulttool get test-results metrics --path <result-bundle> --compact
```

`scripts/test-ios` prints the result bundle path when it starts.

## History insertion during a native drag

`ChatHostedTests/testHistoryInsertionPreservesReaderDuringNativeDrag` and its
`testLargeLoadedHistoryInsertionPreservesReaderDuringNativeDrag` variant require
an external native gesture driver. Run `scripts/test-history-drag` as described
in `DEVELOPMENT.md`; add `--large-history` for 1,000 already-loaded messages.
Ordinary CI skips these external-driver cases rather than substituting a stationary scroll.

The fixture holds an older page until a real UIKit drag begins. A continuous
`UIUpdateLink` samples the rendered message and its local point under the finger,
including the finger's pan translation. Every sample must retain the same message
within 2 points; the longest display-update gap during the drag must stay below
100 ms. The first sample excludes the wait for the external driver. The test also
recycles and revisits expanded work, then checks a second prepend.

These Debug simulator thresholds detect large regressions; they are not a phone
frame-rate guarantee. The iPhone verdict remains required for this change.
On the iPhone 17 Pro simulator running iOS 27.0, the original lazy prepend lost
the reader during dragging. Keeping every lightweight row mounted preserved the
reader but stalled for 212 ms with 1,000 loaded messages. Aggregating distant rows
into spacers retained the reader within 0.67 points, with 58 ms and 81 ms maximum
update gaps in two independent runs. The window's deterministic extent and
node-count assertions run in `ChatTranscriptRowCacheTests` in ordinary CI.

The final navigation/admission correction passed both native cases again: 79
samples at the normal page and 76 with 1,000 loaded messages, with maximum
update gaps of 72 ms and 65 ms respectively. Both retained one rendered reader
within 0.67 points and passed expanded-work recycling and a second prepend.

`scripts/test-history-drag --fling` runs
`testHistoryInsertionPreservesNativeDeceleration` with a real fast swipe. It
tracks the rendered message marker after touch-up, independently of transcript
height estimates. The pan's actual touch count identifies finger release:
UIKit can report `isDragging` throughout deceleration. The check requires
continued rendered motion, no backward movement over 2 points, and a slow
native ending, while retaining the same 100 ms display-update budget.
It also rejects a pause over that budget before a forward jump while substantial
coasting remains. Row admission yields to actual native movement between
measurements, so rendering cannot run ahead of the scrolling update.
The controller's focused tests also check momentum during a size-changing turn
and measurement arriving after the original prepend deadline.
