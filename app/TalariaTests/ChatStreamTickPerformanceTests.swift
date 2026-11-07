import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Chat stream tick and keystroke budget (TAL-851).
///
/// Every streamed token and every composer keystroke should cost the chat screen only the work that changed. This
/// hosts the real chat over a long, busy transcript, drives stream ticks and draft edits through their real paths,
/// and counts the main-thread work each one repeats: reasoning-card derivation, streaming Markdown splits, code
/// highlighting, and body evaluations of settled transcript rows, the message list and the whole chat. Work a tick
/// or keystroke causes recurs in every run, while an unrelated timer-driven update lands in at most one, so each
/// count's minimum across the runs is asserted exactly; the tickets that remove each repeat lower its count.
/// Wall-clock and CPU are recorded for comparison, with one ceiling that leaves headroom for a loaded CI host.
@MainActor
final class ChatStreamTickPerformanceTests: XCTestCase {
    private static let tickCount = 200
    private static let keystrokeCount = 200

    /// Today's counts per phase, recorded on `main` before any of the per-tick fixes landed. A settled row never
    /// re-renders today, so its count is absent.
    private static let expectedTickWork = [
        "reasoningGroups": 400, "markdownSplit": 1_204, "highlight": 100, "messages": 400
    ]
    private static let expectedKeystrokeWork = [
        "reasoningGroups": 204, "markdownSplit": 2, "messages": 204, "chat": 204, "toolbar.horizontal": 204,
        "composer": 212
    ]

    /// Ceiling on the 400 measured operations together. They measure ~12.2 s on a Debug simulator
    /// (`docs/performance-budgets.md`), so this is ~5x headroom for a loaded host.
    private static let maximumSeconds = 60.0

    override func tearDown() {
        MainActor.assumeIsolated { ChatBodyEvaluationRecorder.installed = nil }
        MockURLProtocol.requestHandler = nil
        ChatViewModel.resetActiveStreamSnapshotsForTesting()
        super.tearDown()
    }

    func testStreamTicksAndKeystrokesStayWithinTheWorkBudget() {
        var samples: [ChatStreamTickSample] = []
        measureAsync(
            metrics: [XCTClockMetric(), XCTCPUMetric()],
            options: performanceOptions(manualWindow: true)
        ) { test in
            let harness = try await ChatStreamTickHarness(test: test)
            defer { harness.tearDown() }
            test.startMeasuring()
            let sample = try await harness.run(ticks: Self.tickCount, keystrokes: Self.keystrokeCount)
            test.stopMeasuring()
            samples.append(sample)
        }

        let report = ChatStreamTickSample.table(samples)
        let attachment = XCTAttachment(string: report)
        attachment.name = "Chat stream tick and keystroke work"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("Chat stream tick and keystroke work\n\(report)")

        XCTAssertFalse(samples.isEmpty, "The budget recorded no runs")
        XCTAssertEqual(minimum(samples.map(\.tickWork)), Self.expectedTickWork, "Stream tick work changed.\n\(report)")
        XCTAssertEqual(minimum(samples.map(\.keystrokeWork)), Self.expectedKeystrokeWork,
                       "Keystroke work changed.\n\(report)")
        let fastest = samples.map(\.totalSeconds).min() ?? .infinity
        XCTAssertLessThan(fastest, Self.maximumSeconds, "The chat's ticks and keystrokes took too long.\n\(report)")
    }

    /// Each kind of work's smallest count across the runs; work missing from any run counts as none.
    private func minimum(_ runs: [[String: Int]]) -> [String: Int] {
        let kinds = Set(runs.flatMap(\.keys))
        return kinds.reduce(into: [:]) { result, kind in
            let count = runs.map { $0[kind, default: 0] }.min() ?? 0
            if count > 0 { result[kind] = count }
        }
    }
}

/// One hosted chat over a test-owned transcript, with a reply streaming into it.
@MainActor
private struct ChatStreamTickHarness {
    let viewModel: ChatViewModel
    let stream: ScriptedSSEStreamingClient
    let window: UIWindow
    let composer: UITextView
    let recorder: ChatBodyEvaluationRecorder

    private static let transcriptMessageCount = 200

    init(test: XCTestCase) async throws {
        let fixture = try FixtureApp(for: test)
        let stream = ScriptedSSEStreamingClient()
        let summary = SessionSummary(sessionId: "session-budget", title: "Stream tick budget")
        let session = Self.sessionJSON()
        let viewModel = try test.makeScriptedChatViewModel(streamClient: stream, sessionSummary: summary) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(session, for: request)
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-budget","stream_id":"stream-budget"}"#,
                                           for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.messages.count, Self.transcriptMessageCount, "The budget transcript did not load")

        let recorder = ChatBodyEvaluationRecorder()
        ChatBodyEvaluationRecorder.installed = recorder
        let window = try test.hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://example.test")!, onAPIError: { _ in },
                     loadsInitialMessages: false, draftStore: fixture.environment.draftStore, viewModel: viewModel)
        }.environment(\.chatBodyEvaluation, recorder)
            .modelContainer(fixture.cache))

        let started = await viewModel.sendMessage("Show the change")
        XCTAssertTrue(started)
        stream.emit(.token(Self.token(0)))
        let opened = await test.awaitCondition { viewModel.messages.last?.content == Self.token(0) }
        XCTAssertTrue(opened, "The streaming reply never reached the transcript")
        var activatedShell = false
        let found = await test.composerTextView(in: window) {
            guard !activatedShell, let shell = HostedAccessibility.element(in: window, label: "Message") else { return }
            HostedAccessibility.activate(shell)
            activatedShell = true
        }
        let composer = try XCTUnwrap(found, "The chat has no composer text view")
        composer.becomeFirstResponder()
        let quiet = await test.awaitQuiet { recorder.counts.values.reduce(0, +) }
        XCTAssertNotNil(quiet, "The chat must stop re-evaluating after the send before measuring")
        // Opening the chat renders settled rows, so a zero count while measuring means none re-rendered.
        XCTAssertGreaterThan(recorder.counts["settledRow", default: 0], 0, "The settled-row counter saw no rows")

        self.viewModel = viewModel
        self.stream = stream
        self.window = window
        self.composer = composer
        self.recorder = recorder
    }

    /// The measured window: `ticks` stream tokens, then `keystrokes` draft edits, each rendered before the next.
    func run(ticks: Int, keystrokes: Int) async throws -> ChatStreamTickSample {
        recorder.reset()
        var expected = Self.token(0)
        let tickStart = DispatchTime.now().uptimeNanoseconds
        for tick in 1...ticks {
            let token = Self.token(tick)
            expected += token
            stream.emit(.token(token))
            await turn()
        }
        let tickSeconds = Self.seconds(since: tickStart)
        XCTAssertEqual(viewModel.messages.last?.content, expected, "A stream tick was dropped")
        let tickWork = recorder.counts

        recorder.reset()
        let keystrokeStart = DispatchTime.now().uptimeNanoseconds
        for keystroke in 0..<keystrokes {
            composer.insertText(keystroke % 6 == 5 ? " " : "a")
            await turn()
        }
        let keystrokeSeconds = Self.seconds(since: keystrokeStart)
        XCTAssertEqual(composer.text.count, keystrokes, "A keystroke was dropped")
        return ChatStreamTickSample(tickWork: tickWork, keystrokeWork: recorder.counts,
                                    tickSeconds: tickSeconds, keystrokeSeconds: keystrokeSeconds)
    }

    /// Renders the change and runs the main-actor work it queued, without waiting on a clock.
    ///
    /// Work a render queues can itself yield before it counts (a code block's highlight task yields once, and the next
    /// tick would cancel it), so one hop is not enough: the main actor runs until the counted work has stayed unchanged
    /// for `quietHops` consecutive hops, each of which also lets SwiftUI commit and start the tasks it queued.
    private func turn() async {
        await viewModel.awaitPendingStreamingScrollTriggerForTesting()
        window.layoutIfNeeded()
        let quietHops = 3
        var counted = recorder.counts.values.reduce(0, +)
        var unchanged = 0
        for _ in 0..<50 where unchanged < quietHops {
            Self.runLoopPass()
            await Task.yield()
            window.layoutIfNeeded()
            let now = recorder.counts.values.reduce(0, +)
            unchanged = now == counted ? unchanged + 1 : 0
            counted = now
        }
        XCTAssertGreaterThanOrEqual(unchanged, quietHops, "The chat's main-actor work never went quiet after a turn")
    }

    /// One run-loop pass, which commits SwiftUI's pending transaction. Async code cannot run the loop directly.
    private static func runLoopPass() {
        RunLoop.current.run(until: Date())
    }

    func tearDown() {
        viewModel.suspendStreamForNavigation()
        viewModel.cleanupPollingTasks()
        stream.stop()
        ChatBodyEvaluationRecorder.installed = nil
        window.isHidden = true
        window.rootViewController = nil
    }

    /// A reply that opens a Swift code block, streams 99 lines into it, closes it and continues in prose.
    private static func token(_ index: Int) -> String {
        switch index {
        case 0: "Here is the change.\n\n```swift\n"
        case 1..<100: "let value\(index) = compute(\(index))\n"
        case 100: "```\n\n"
        default: "word\(index) "
        }
    }

    /// 100 turns: every fifth reply carries reasoning and every fifth, offset by two, a fenced code block.
    private static func sessionJSON() -> String {
        let messages = (0..<transcriptMessageCount).map { index -> [String: Any] in
            let turn = index / 2
            if index.isMultiple(of: 2) {
                return ["role": "user", "content": "Question \(turn) about the budget fixture.",
                        "message_id": "user-\(turn)"]
            }
            var content = "Answer \(turn) explains the change in two short paragraphs.\n\nIt keeps the rest as it was."
            if turn % 5 == 2 {
                content += "\n\n```swift\nfunc answer\(turn)() -> Int {\n    \(turn) * 2\n}\n```\n"
            }
            var message: [String: Any] = ["role": "assistant", "content": content, "message_id": "assistant-\(turn)"]
            if turn.isMultiple(of: 5) {
                message["reasoning"] = "Reasoning for answer \(turn): check the request, then write the reply."
            }
            return message
        }
        let body: [String: Any] = ["session": ["session_id": "session-budget", "title": "Stream tick budget",
                                               "messages": messages]]
        let data = try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private static func seconds(since start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
    }
}

private struct ChatStreamTickSample {
    let tickWork: [String: Int]
    let keystrokeWork: [String: Int]
    let tickSeconds: Double
    let keystrokeSeconds: Double
    var totalSeconds: Double { tickSeconds + keystrokeSeconds }

    static func table(_ samples: [Self]) -> String {
        func line(_ run: Int, _ phase: String, _ seconds: Double, _ work: [String: Int]) -> String {
            let counts = work.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            return "run \(run): \(phase) \(String(format: "%.0f", seconds * 1000)) ms \(counts)"
        }
        return samples.enumerated().flatMap { index, sample in
            [line(index + 1, "ticks", sample.tickSeconds, sample.tickWork),
             line(index + 1, "keystrokes", sample.keystrokeSeconds, sample.keystrokeWork)]
        }.joined(separator: "\n")
    }
}
