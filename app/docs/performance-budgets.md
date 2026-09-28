# Performance budgets

The measurements that guard Talaria's slowest user-visible paths (TAL-75), the
baselines the thresholds came from, and how to compare a run against them.

## Where each budget lives

A budget goes as close to the work as it can be measured honestly. A path whose
cost is an algorithm is measured in `TalariaTests`, where the numbers are stable
enough to assert on; a path whose cost is the rendered app is measured in
`TalariaUITests` against the deterministic launch fixture.

| Budget | Test | Runs on |
| --- | --- | --- |
| Streaming replay catch-up scaling | `TalariaTests/ReplayCatchUpPerformanceTests` | every run |
| Dense Kanban load and filter | `TalariaTests/KanbanBoardPerformanceTests` | every run |
| Large image preview preparation | `TalariaTests/ImagePreviewPerformanceTests` | every run |
| Cold and warm launch | `TalariaUITests/LaunchPerformanceUITests` | daily UI Performance workflow, full local suite |
| Large transcript open and scroll | `TalariaUITests/TranscriptPerformanceUITests` | daily UI Performance workflow, full local suite |
| Repeated navigation and dismissal | `TalariaUITests/NavigationPerformanceUITests` | daily UI Performance workflow, full local suite |
| Sidebar close hitch | `TalariaUITests/SidebarPerformanceUITests` | daily UI Performance workflow, full local suite |

The UI classes repeat each path under `measure` and together add several
minutes of relaunching and scrolling, so CI and the UI suite
(`.github/workflows/app-tests.yml`) skip them on every run through the skip list
in `ci/test_shards.py`.
`.github/workflows/ui-performance.yml` runs them daily at 09:00 UTC (or on
dispatch) serially on a GitHub-hosted macOS runner and keeps the metrics as the
run's `performance-metrics-<attempt>` artifact for 30 days. Their functional
halves (warm resume, dense session open and dismiss) run once without measuring
in `TalariaUITests/PerformancePathUITests`, which stays in the nightly UI suite. The
unit-level budgets are fast and deterministic, so they stay in the pull-request
suite where a regression is introduced.

## Fixture data

Every budget measures fixed content, so two runs differ only in the code under
them.

- The UI budgets launch with `--ui-test-dense`, which scales the fixture server
  to 300 sessions and a 600-message transcript. The functional fixtures keep the
  small counts.
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
| Cold launch to session list (`Duration (AppLaunch)`) | 1.372 s | 0.034 s |
| Cold launch to session list (peak memory) | 67,898 kB | — |
| Warm resume to session list (clock) | 1.240 s | 0.030 s |
| Warm resume to session list (CPU time) | 0.255 s | — |
| Dense transcript open (clock) | 5.466 s | 0.129 s |
| Dense transcript open (peak memory) | 228,838 kB | 5,636 kB |
| Dense transcript scroll, 6 swipes (clock) | 33.589 s | 1.499 s |
| Repeated open/dismiss, 3 cycles (clock) | 32.287 s | 0.105 s |
| Repeated open/dismiss (peak memory) | 225,578 kB | 1,311 kB |
| Replay catch-up, 4,000 tokens (clock) | 0.009 s | 0.000 s |
| Replay catch-up, 4,000 tokens (peak memory) | 53,447 kB | 16 kB |

The clock figures for the scroll and navigation budgets cover the whole
scripted interaction, including the XCUI gesture and query time, so they are
comparison points between runs rather than a claim about frame cost.

Only two budgets assert a threshold. The rest record for comparison, because a
wall-clock assertion over a simulator gesture or a whole XCUI launch cycle is a
flake, not a signal.

- Replay catch-up may not cost more than 8x across the curve's 4x span, and
  4,000 tokens may not take more than 80 ms. A linear path measures ~3.9x and
  ~8.7 ms; the quadratic path this replaced measured ~16x and 212 ms. The
  endpoints are compared rather than each step because at these millisecond
  scales one noisy middle sample decides a per-step ratio.
- Warm resume to a responsive session list must stay under 3.0 s. The resume
  window is narrow and repeatable (1.24 s median, 30 ms spread), so a threshold
  on it holds.

`XCTHitchMetric` is attached to the scroll budget and to the older sidebar
budget, but this simulator runtime records no hitch measurements for either, so
those budgets read on wall time and CPU.

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
scripts/test-ios TalariaUITests/LaunchPerformanceUITests
xcrun xcresulttool get test-results metrics --path <result-bundle> --compact
```

`scripts/test-ios` prints the result bundle path when it starts.
