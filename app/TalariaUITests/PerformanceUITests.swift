import XCTest

/// Performance budgets for the launched app (TAL-75).
///
/// The measuring classes repeat each path several times under `measure`, so CI
/// skips them and the scheduled UI Performance workflow runs them serially and
/// keeps their metrics (TAL-287); the full local suite runs them too. The nightly
/// and release UI suite no longer runs their paths separately (TAL-402).
///
/// The deterministic fixture serves the dense transcript and session list
/// (`--ui-test-dense`), so every run measures the same content.
class PerformanceUITestCase: TalariaUITestCase {
    /// Three iterations per budget, matching `SidebarPerformanceUITests`: enough
    /// for XCTest to report a spread, cheap enough to leave in CI.
    static let iterationCount = 3

    func measureOptions(manualWindow: Bool) -> XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = Self.iterationCount
        if manualWindow {
            options.invocationOptions = [.manuallyStart, .manuallyStop]
        }
        return options
    }

    func launchDenseFixture(additionalArguments: [String] = []) {
        launchFixture(additionalArguments: ["--ui-test-dense"] + additionalArguments)
    }

    var denseSessionRow: XCUIElement {
        app.buttons.containing(.staticText, identifier: "UI Fixture Session").firstMatch
    }

    func waitForSessionList() {
        XCTAssertTrue(
            denseSessionRow.awaitExistence(timeout: 30),
            "Missing the deterministic dense session fixture"
        )
    }

    /// The transcript reports its rows as not hittable, so taps go by coordinate.
    func tapCentre(of element: XCUIElement) {
        let frame = element.frame
        XCTAssertTrue(frame.width > 0 && frame.height > 0, "Tap target has no frame")
        app.coordinate(withNormalizedOffset: CGVector(
            dx: frame.midX / app.frame.width,
            dy: frame.midY / app.frame.height
        )).tap()
    }

    func waitForComposer(timeout: TimeInterval = 30) -> Bool {
        let idle = app.buttons["Message"]
        let expanded = app.textViews.firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if idle.exists || expanded.exists { return true }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        return false
    }

    func openDenseSession() {
        waitForSessionList()
        tapCentre(of: denseSessionRow)
        XCTAssertTrue(waitForComposer(), "The dense fixture session never opened")
    }
}

/// Cold and warm launch (TAL-75).
final class LaunchPerformanceUITests: PerformanceUITestCase {
    /// Cold launch: each iteration terminates the running app and starts a new
    /// process, so the measurement covers process start through the first
    /// responsive frame of the dense session list.
    func testColdLaunchToSessionList() {
        measure(
            metrics: [
                XCTApplicationLaunchMetric(),
                XCTCPUMetric(application: app),
                XCTMemoryMetric(application: app)
            ],
            options: measureOptions(manualWindow: false)
        ) {
            launchDenseFixture()
            waitForSessionList()
        }
    }

    /// Warm launch: the process survives, so this is the resume path — the cost
    /// of restoring the dense session list rather than of starting up.
    func testWarmLaunchFromBackground() {
        launchDenseFixture()
        waitForSessionList()

        measure(
            metrics: [XCTClockMetric(), XCTCPUMetric(application: app), XCTMemoryMetric(application: app)],
            options: measureOptions(manualWindow: true)
        ) {
            sendToBackground()

            startMeasuring()
            let start = Date()
            app.activate()
            waitForSessionList()
            let elapsed = Date().timeIntervalSince(start)
            stopMeasuring()

            // The one wall-clock budget on this lane: the resume window is
            // narrow and repeatable (1.24 s median, 30 ms spread), so a
            // threshold here is a signal rather than a flake.
            XCTAssertLessThan(
                elapsed, Self.warmResumeBudgetSeconds,
                "Warm resume to a responsive session list took \(Int(elapsed * 1000)) ms"
            )
        }
    }

    /// From repeated baselines on an iPhone 17 Pro simulator, iOS 26.4.1 (see
    /// `docs/performance-budgets.md`), with headroom for a loaded CI host.
    private static let warmResumeBudgetSeconds: TimeInterval = 3.0
}

/// Opening and scrolling a large transcript (TAL-75).
final class TranscriptPerformanceUITests: PerformanceUITestCase {
    /// Open: the tap on a session row through to a responsive composer over the
    /// 600-message fixture transcript.
    func testDenseTranscriptOpens() {
        launchDenseFixture()

        measure(
            metrics: [XCTClockMetric(), XCTCPUMetric(application: app), XCTMemoryMetric(application: app)],
            options: measureOptions(manualWindow: true)
        ) {
            waitForSessionList()

            startMeasuring()
            tapCentre(of: denseSessionRow)
            XCTAssertTrue(waitForComposer(), "The dense fixture session never opened")
            stopMeasuring()

            app.navigationBars.buttons["BackButton"].firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: 15))
        }
    }

    /// Open a transcript of 20-100K-character bodies in the server's collapsed shape (TAL-456):
    /// memory here is what ran the App out of its per-process limit before excerpts.
    func testLongBodyTranscriptOpens() {
        launchFixture(additionalArguments: ["--ui-test-long-bodies"])

        measure(
            metrics: [XCTClockMetric(), XCTMemoryMetric(application: app)],
            options: measureOptions(manualWindow: true)
        ) {
            waitForSessionList()

            startMeasuring()
            tapCentre(of: denseSessionRow)
            XCTAssertTrue(waitForComposer(), "The long-body fixture session never opened")
            stopMeasuring()

            app.navigationBars.buttons["BackButton"].firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: 15))
        }
    }

    /// Scroll: a fixed sweep back through the transcript. Hitches are the signal
    /// here — a dropped frame during scrolling is what a user actually sees, and
    /// `XCTHitchMetric` needs iOS 26 the same way `SidebarPerformanceUITests` does.
    @available(iOS 26.0, *)
    func testDenseTranscriptScrolls() {
        launchDenseFixture()
        openDenseSession()
        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.awaitExistence(timeout: 15), "Missing the transcript scroll view")

        measure(
            metrics: [XCTClockMetric(), XCTHitchMetric(application: app), XCTCPUMetric(application: app)],
            options: measureOptions(manualWindow: false)
        ) {
            for _ in 0..<6 {
                transcript.swipeDown(velocity: .fast)
            }
        }
    }
}

/// Repeated navigation and dismissal (TAL-75): the push/pop cycle that leaks
/// most visibly, measured with memory alongside time.
final class NavigationPerformanceUITests: PerformanceUITestCase {
    func testRepeatedSessionOpenAndDismiss() {
        launchDenseFixture()
        waitForSessionList()

        measure(
            metrics: [XCTClockMetric(), XCTMemoryMetric(application: app), XCTCPUMetric(application: app)],
            options: measureOptions(manualWindow: false)
        ) {
            for _ in 0..<3 {
                tapCentre(of: denseSessionRow)
                XCTAssertTrue(waitForComposer(), "The dense fixture session never opened")
                app.navigationBars.buttons["BackButton"].firstMatch.tap()
                XCTAssertTrue(
                    app.navigationBars["Chats"].awaitExistence(timeout: 15),
                    "The transcript never dismissed back to the session list"
                )
            }
        }
    }
}
