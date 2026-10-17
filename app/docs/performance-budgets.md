# Performance budgets

The measurements that guard Talaria's slowest user-visible paths (TAL-75), the
baselines the thresholds came from, and how to compare a run against them.

## Where each budget lives

Every budget measures an algorithm in `TalariaTests`, where the numbers are
stable enough to assert on, and runs in the pull-request suite where a
regression is introduced. Launch, transcript scrolling, navigation and the
sidebar are checked on a device against the release phone list
(`docs/phone-checks.md`), in Instruments when a change touches them.

| Budget | Test |
| --- | --- |
| Streaming replay catch-up scaling | `TalariaTests/ReplayCatchUpPerformanceTests` |
| Dense Kanban load and filter | `TalariaTests/KanbanBoardPerformanceTests` |
| Large image preview preparation | `TalariaTests/ImagePreviewPerformanceTests` |

## Fixture data

Every budget measures fixed content, so two runs differ only in the code under
them.

- The Kanban budget decodes a generated 1,200-card Board across six columns.
- The image budget encodes a deterministic 4032x3024 tile pattern as JPEG.
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

Only the replay budget asserts a threshold; the others record for comparison.

- Replay catch-up may not cost more than 8x across the curve's 4x span, and
  4,000 tokens may not take more than 80 ms. A linear path measures ~3.9x and
  ~8.7 ms; the quadratic path this replaced measured ~16x and 212 ms. The
  endpoints are compared rather than each step because at these millisecond
  scales one noisy middle sample decides a per-step ratio.

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
Ordinary CI skips these two cases rather than substituting a stationary scroll.

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
