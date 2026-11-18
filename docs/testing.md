# Writing and fixing tests

Every added or changed test passes the `test-audit` skill's authoring gate and its defect rules: `clock`, `snapshot`, `unheld`, `ready`, `leak`, `host`, `fake`, `vacuous`, `heavy`, `oversized` and `matrix`. The first ten come from 279 Talaria test fixes (TAL-2403); `matrix` came from TAL-2401 through the defect loop below. The skill's defect examples are Talaria's own. This page lists the Talaria helpers that satisfy each rule, the two CI checks, and the loop for fixing a test.

## Helpers by rule

| Rule | Use |
|---|---|
| clock | App: `ManualTestClock` (TalariaKit `APITestSupport.swift`). Web and Relay: `vi.useFakeTimers({ now })`, or the clock and timeout a server or sidecar function takes as an argument. A wait on an event is bounded by one shared ceiling such as `awaitCondition`'s 10 s, the server suite's 20 s `testTimeout` or `waitForRelay` (server `relay.test.ts`), never by a short deadline of its own. |
| snapshot | App: `awaitCondition` and `awaitElement` (`FixtureApp.swift`). Web: `findBy*`, `vi.waitFor`, `expect.poll` and Playwright's auto-waiting `expect(locator)`. Read the record the owner commits: the state.db row, the reread after a write, a log line the owner writes. |
| unheld | `vi.useFakeTimers` around convex-test's scheduler and workpool, `holdTurns(sidecar)` (`prompt-queue.test.ts`), `openStateDb` with its 5 s busy timeout (server `src/test/harness.ts`, `e2e/server.ts`), and an awaited `close()`. |
| ready | The hosted-test warm-up in `FixtureApp.swift` draws the fixture chat once before any test. `scripts/prepare-ui-simulator` and `scripts/ready-simulator-notifications` ready the simulator. `HostedScene.window(size:)` sizes its own window. A sidecar case that reaches a real Agent plugin admission carries `@pytest.mark.pm_store`: `suite_runner.py` warms one PM toolchain and uv cache before workers start, and `share_pm_store` links the case's Hermes root into it. |
| leak | `assertPortFree` (`e2e/server.ts`), a temporary `HOME` and state directory per test, `afterEach` drains of every Relay backend, and `page.unrouteAll({ behavior: 'ignoreErrors' })` before a page closes. |
| host | `realpathSync(mkdtempSync(...))` for temp paths, controls driven through `sendActions(for:)` rather than synthesized touches, and the hosted window's own size rather than device constants. |
| fake | `FakeSidecar` and `bootTestServer` (server `src/test/harness.ts`). A fake HTTP peer answers 404 to any path it does not own. |
| vacuous | `expect_eq` from `app/ci/test_assertions.sh` in shell tests, because macOS bash 3.2 ignores a failed `[[ ]]` under `set -e`. Scope XCUI and Testing Library queries to the row under test. |
| heavy | `TEST_DRAIN` in the server harness, injected timeouts instead of production waits, and a real process only for a property listed in `web/sidecar/tests/process_inventory.json`. |
| oversized | One test per behaviour over a shared fixture. A hosted test that walks several settings pages or scenarios splits by page or scenario. |
| matrix | A test run once per supported release or configuration takes each expected value from the fixture it loaded. `expectedAppSnapshot` in `relay/tests/sharedContracts.test.ts` builds the App snapshot from the publisher fixture it read and drops each optional run field that fixture omits (TAL-2401, #1795). |

## Checks in CI

**Test rules.** The Repository Tooling job runs `node scripts/check-ui-rules.mjs --config scripts/test-rules.json` on every PR. It fails a test file that adds a fixed sleep (`clock-sleep`), measures elapsed time (`clock-elapsed`), fakes `Date.now` beside real timers (`unheld-clock`), or retries a test (`retry`, `retry-config`). No pattern can tell a literal copied from one fixture from a correct expectation, so `matrix`, like the other rules, is held by review. Every count in `scripts/test-rules-baseline.json` predates the check and belongs to TAL-2406. After removing one, run the command with `--update` to lower the baseline; `--update` never raises a count. A legitimate new instance, such as a fake that simulates latency, gets a hand-written `exceptions` entry in that file with its rule, file, count and a one-sentence reason, and the PR review covers it.

**Which App tests run.** A pull request and a `main` push run only the App tests their diff reaches: `scripts/changed-components.py --app-plan` narrows TalariaKit and TalariaTests to explicit identifiers, leaves a target out, or runs it in full when it cannot bound the change (TAL-2390, TAL-2544). A `main` push's diff starts at the last `main` run that completed (TAL-2461). GitHub Scheduler dispatches CI on `main` daily before Nightly, and that manual run runs every suite; a release reuses its `App / App hosted tests` on that commit and runs the hosted suite itself on any other.

**Hung tests.** A hosted test that runs past one minute, XCTest's shortest per-test allowance (`-default-test-execution-time-allowance 60`), fails by name with a spindump and the shard goes on. The shard's test step stops at 30 minutes, above its slowest measured run: 13 minutes at four shards, 19.5 at a release's two.

**Run-time budget.** Each test job runs `scripts/check-test-durations.py` on its own report: App hosted tests, Web server and frontend Vitest, Playwright e2e and the sidecar suite. A test over 30 s fails the job. The 30 s budget is TAL-1897's target. The App hosted tests' p99 measured 23 to 26 s on main, and every other suite's p99 measured about 14 s or less. `overBudget` in `scripts/test-durations.json` lists, with TAL-2405, each test that measured over 20 s on main, because the same test's time varied up to 1.9x between two main runs. Add an entry only with a ticket that brings the test back under budget.

## Fixing a defective test

A test that failed intermittently, ran over budget or covered too much follows the test-audit defect loop:

1. Reproduce the failure. For an App hosted test, run it on its own and alongside its shard; for Web, run it with `--repeat-each` or in a loop under parallel load.
2. Name the defect rule it broke in the PR body. If the test was right and caught a product race, as with TAL-2344 and TAL-2398, fix the product and name no rule.
3. A cause no rule names gets a new rule, with its Talaria before and after, in the test-audit skill alongside the fix. If a diff can show the cause, add a pattern to `scripts/test-rules.json` too.

Never retry, skip, loosen an assertion or raise a timeout to get green.
