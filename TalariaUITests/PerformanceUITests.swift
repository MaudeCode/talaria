import XCTest

/// Performance budgets for the launched app (TAL-75).
///
/// Every class here is measurement-only: it asserts nothing about layout or
/// behaviour, so it carries no correctness signal and can be skipped when a run
/// needs to stay fast. Pull-request CI skips them and `main` CI runs them and
/// retains the result bundle for comparison; the full local suite runs them too.
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
            denseSessionRow.waitForExistence(timeout: 30),
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

    /// Backgrounds the app under test. On this simulator a home press alone
    /// leaves it in `runningForeground`; following the press with an explicit
    /// Springboard activation and letting it settle is what actually suspends
    /// it. Neither works from inside a `measure` block, which is why the warm
    /// launch budget times its own window.
    func background() {
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        XCUIApplication(bundleIdentifier: "com.apple.springboard").activate()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertNotEqual(
            app.state, .runningForeground,
            "The app never left the foreground"
        )
    }

    func median(of samples: [TimeInterval]) -> TimeInterval {
        samples.sorted()[samples.count / 2]
    }

    func formatted(_ samples: [TimeInterval]) -> String {
        samples.map { String(format: "%.0f ms", $0 * 1000) }.joined(separator: ", ")
    }

    /// Keeps the samples in the result bundle so CI runs stay comparable.
    func report(_ samples: [TimeInterval], named name: String) {
        let text = "\(name): median \(formatted([median(of: samples)])) over \(formatted(samples))"
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
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
        measure(metrics: [XCTApplicationLaunchMetric()], options: measureOptions(manualWindow: false)) {
            launchDenseFixture()
            waitForSessionList()
        }
    }

    /// Warm launch: the process survives, so this is the resume path — the cost
    /// of restoring the dense session list rather than of starting up.
    ///
    /// `measure` keeps the app under test in the foreground for the whole block,
    /// so a resume cannot happen inside one. The resume is timed directly
    /// instead, and the samples are attached for comparison the same way the
    /// replay catch-up curve is.
    func testWarmLaunchFromBackground() {
        launchDenseFixture()
        waitForSessionList()

        var samples: [TimeInterval] = []
        for _ in 0..<Self.iterationCount {
            background()
            let start = Date()
            app.activate()
            waitForSessionList()
            samples.append(Date().timeIntervalSince(start))
        }

        report(samples, named: "Warm launch resume")
        XCTAssertLessThan(
            median(of: samples), Self.warmResumeBudgetSeconds,
            "Warm resume to a responsive session list regressed: \(formatted(samples))"
        )
    }

    /// Budget from repeated baselines on an iPhone 17 Pro simulator, iOS 26.4.1
    /// (see `docs/performance-budgets.md`), with headroom for a loaded CI host.
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
            XCTAssertTrue(app.navigationBars["Chats"].waitForExistence(timeout: 15))
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
        XCTAssertTrue(transcript.waitForExistence(timeout: 15), "Missing the transcript scroll view")

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
                    app.navigationBars["Chats"].waitForExistence(timeout: 15),
                    "The transcript never dismissed back to the session list"
                )
            }
        }
    }
}
