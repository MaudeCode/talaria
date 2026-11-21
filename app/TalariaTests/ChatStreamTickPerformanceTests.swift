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
/// highlighting, built code lines, and body evaluations of settled transcript rows and bubbles, the message list and
/// the whole chat. Work a tick or keystroke causes recurs in every run, while an unrelated timer-driven update lands
/// in at most one, so each count's minimum across two runs is asserted exactly; the tickets that remove each repeat
/// lower its count. Wall-clock time is attached for comparison and decides nothing. The streamed text's fade window
/// absorbs a finished block into the solid head once its fade has run for a wall-clock delay, which landed inside the
/// measured ticks only on a slow host, so the harness holds the fade open for the whole test (TAL-2534). That also holds
/// off the fade clock's pause, which waits on the same fade duration, so neither wall-clock event lands while measuring.
///
/// Hosting the chat and raising the keyboard cost more than the measured work, so ticks and keystrokes are separate
/// tests and each takes both runs in one hosted chat: one test that hosted the chat twice for both ran past the hosted
/// one-minute allowance on a swapping runner (TAL-2610).
@MainActor
final class ChatStreamTickPerformanceTests: XCTestCase {
    private static let tickCount = 40
    private static let keystrokeCount = 60
    private static let runCount = 2

    /// Today's counts per phase. A settled row or bubble never re-renders, code is highlighted off the main thread
    /// (TAL-854), reasoning cards are derived only when the transcript changes (TAL-855), and the transcript's
    /// reading-place hold fires only when an excerpt changes (`excerptHold`, TAL-1242), so their counts are absent.
    /// The streaming fence keeps its view and rebuilds only its open group of lines, and builds every line once more
    /// when it closes and moves into the Markdown (TAL-1396). A keystroke re-runs only the composer; the chat's one
    /// pass follows the composer's height as the draft wraps (TAL-852).
    private static let expectedTickWork = [
        "markdownSplit": 40, "messages": 40, "codeLine": 246
    ]
    private static let expectedKeystrokeWork = [
        "messages": 1, "chat": 1, "toolbar.horizontal": 1, "composer": 63
    ]

    override func tearDown() {
        StreamingTextFadeLab.shared.reset()
        MainActor.assumeIsolated { ChatBodyEvaluationRecorder.installed = nil }
        MockURLProtocol.requestHandler = nil
        ChatViewModel.resetActiveStreamSnapshotsForTesting()
        super.tearDown()
    }

    /// Each run sends from the composer, as a reader does, and streams one reply; the second reply follows the first's
    /// settled row.
    func testStreamTicksStayWithinTheWorkBudget() async throws {
        let harness = try await ChatStreamTickHarness(test: self)
        defer { harness.tearDown() }
        var samples: [ChatWorkSample] = []
        for run in 1...Self.runCount {
            try await harness.openReply(sending: "Show change \(run)")
            samples.append(try await harness.streamTicks(Self.tickCount))
            await harness.endReply()
        }
        assertMinimum(samples, equals: Self.expectedTickWork, phase: "Stream tick")
    }

    /// The fixture ends in a settled reply, so typing can start from the same state without sending a setup prompt.
    /// Each run types into an empty draft.
    func testKeystrokesStayWithinTheWorkBudget() async throws {
        let harness = try await ChatStreamTickHarness(test: self)
        defer { harness.tearDown() }
        var samples: [ChatWorkSample] = []
        for _ in 1...Self.runCount {
            samples.append(try await harness.type(Self.keystrokeCount))
        }
        assertMinimum(samples, equals: Self.expectedKeystrokeWork, phase: "Keystroke")
    }

    private func assertMinimum(_ samples: [ChatWorkSample], equals expected: [String: Int], phase: String) {
        let report = samples.enumerated().map { $0.element.line(run: $0.offset + 1) }.joined(separator: "\n")
        let attachment = XCTAttachment(string: report)
        attachment.name = "\(phase) work"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("\(phase) work\n\(report)")
        XCTAssertEqual(minimum(samples.map(\.work)), expected, "\(phase) work changed.\n\(report)")
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

/// One hosted chat over a test-owned transcript, with the keyboard up and replies streaming into it on demand.
@MainActor
private struct ChatStreamTickHarness {
    let viewModel: ChatViewModel
    let stream: ScriptedSSEStreamingClient
    let window: UIWindow
    let recorder: ChatBodyEvaluationRecorder
    private let test: XCTestCase

    private static let transcriptMessageCount = 200
    /// A fade far longer than the test, so no streamed block's absorption delay elapses while it measures.
    private static let heldFadeDuration: TimeInterval = 3_600

    init(test: XCTestCase) async throws {
        StreamingTextFadeLab.shared.fadeDuration = Self.heldFadeDuration
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

        // The keyboard's first show shrinks the viewport and the long transcript's lazy rows re-measure under it. A pass
        // that moves the offset before the content height reads as the reader scrolling away and can release follow,
        // which left the stream ticks scrolling an unfollowed transcript on a slow host. Raise the keyboard first and send
        // from the composer, as a reader does: the send re-arms follow once the re-measure has settled (TAL-2002).
        _ = try await Self.focusComposer(in: window, test: test)
        let keyboardSettled = await test.awaitQuiet { recorder.counts.values.reduce(0, +) }
        XCTAssertNotNil(keyboardSettled, "The chat must settle under the keyboard before measuring")
        // Opening the chat renders settled rows, so a zero count while measuring means none re-rendered.
        XCTAssertGreaterThan(recorder.counts["settledRow", default: 0], 0, "The settled-row counter saw no rows")

        self.viewModel = viewModel
        self.stream = stream
        self.window = window
        self.recorder = recorder
        self.test = test
    }

    /// Sends `message` from the composer and waits until the reply's first token reached the transcript and the chat
    /// went quiet. An empty composer that loses focus while the keyboard comes up folds back into its shell, so the send
    /// types into whichever composer is mounted by then, not the one focused first (TAL-2549).
    func openReply(sending message: String) async throws {
        try await test.sendFromComposer(message, in: window)
        let started = await test.awaitCondition { viewModel.activeStreamID != nil }
        XCTAssertTrue(started, "The composer's send never started the reply")
        stream.emit(.token(Self.token(0)))
        let opened = await test.awaitCondition { viewModel.messages.last?.content == Self.token(0) }
        XCTAssertTrue(opened, "The streaming reply never reached the transcript")
        let quiet = await test.awaitQuiet { recorder.counts.values.reduce(0, +) }
        XCTAssertNotNil(quiet, "The chat must stop re-evaluating after the send before measuring")
    }

    /// The measured window: `ticks` stream tokens into the open reply, each rendered before the next.
    func streamTicks(_ ticks: Int) async throws -> ChatWorkSample {
        recorder.reset()
        var expected = Self.token(0)
        var lineWork: [Int] = []
        let start = DispatchTime.now().uptimeNanoseconds
        for tick in 1...ticks {
            let previousLines = recorder.counts["codeLine", default: 0]
            let token = Self.token(tick)
            expected += token
            stream.emit(.token(token))
            await turn()
            lineWork.append(recorder.counts["codeLine", default: 0] - previousLines)
        }
        let seconds = Self.seconds(since: start)
        XCTAssertEqual(viewModel.messages.last?.content, expected, "A stream tick was dropped")
        let ticksByLine = lineWork.enumerated().map { "\($0.offset + 1)=\($0.element)" }.joined(separator: " ")
        return ChatWorkSample(work: recorder.counts, seconds: seconds, detail: "codeLine by tick \(ticksByLine)")
    }

    func endReply() async {
        stream.emit(.done(DoneStreamEvent()))
        stream.emit(.streamEnd)
        let ended = await test.awaitCondition { viewModel.activeStreamID == nil }
        XCTAssertTrue(ended, "The reply never ended")
    }

    /// The measured window: `keystrokes` draft edits into an empty draft, each rendered before the next. The draft is
    /// cleared afterwards, so the next run types the same text.
    func type(_ keystrokes: Int) async throws -> ChatWorkSample {
        // Ending a reply or clearing the draft can replace the empty editor with its collapsed shell. Measure input in the
        // mounted composer, rather than retaining a dismantled UITextView whose delegate no longer publishes draft edits.
        let composer = try await Self.focusComposer(in: window, test: test)
        XCTAssertEqual(composer.text, "", "Each run types into an empty draft")
        let quiet = await test.awaitQuiet { recorder.counts.values.reduce(0, +) }
        XCTAssertNotNil(quiet, "The chat must stop re-evaluating before typing")
        recorder.reset()
        let start = DispatchTime.now().uptimeNanoseconds
        for keystroke in 0..<keystrokes {
            composer.insertText(keystroke % 6 == 5 ? " " : "a")
            await turn()
        }
        let seconds = Self.seconds(since: start)
        XCTAssertTrue(composer.window === window && composer.delegate != nil,
                      "The measured keystrokes must reach the mounted composer's delegate")
        XCTAssertEqual(composer.text.count, keystrokes, "A keystroke was dropped")
        let work = recorder.counts
        composer.selectAll(nil)
        composer.deleteBackward()
        return ChatWorkSample(work: work, seconds: seconds, detail: nil)
    }

    private static func focusComposer(in window: UIWindow, test: XCTestCase) async throws -> UITextView {
        test.settle(window: window)
        var activatedShell = false
        let found = await test.composerTextView(in: window) {
            guard !activatedShell, let shell = HostedAccessibility.element(in: window, label: "Message") else { return }
            activatedShell = HostedAccessibility.activate(shell)
        }
        let composer = try XCTUnwrap(found, "The chat has no composer text view")
        XCTAssertTrue(composer.window === window && composer.delegate != nil,
                      "The benchmark must focus a mounted composer")
        composer.becomeFirstResponder()
        return composer
    }

    /// Renders the change and runs the main-actor work it queued, without waiting on a clock.
    private func turn() async {
        await viewModel.awaitPendingStreamingScrollTriggerForTesting()
        let quiet = await test.awaitRenderedQuiet(in: window) { recorder.counts.values.reduce(0, +) }
        XCTAssertTrue(quiet, "The chat's main-actor work never went quiet after a turn")
    }

    func tearDown() {
        viewModel.suspendStreamForNavigation()
        viewModel.cleanupPollingTasks()
        stream.stop()
        ChatBodyEvaluationRecorder.installed = nil
        window.isHidden = true
        window.rootViewController = nil
    }

    /// A reply that opens a Swift code block, streams 19 lines into it, closes it and continues in prose.
    private static func token(_ index: Int) -> String {
        switch index {
        case 0: "Here is the change.\n\n```swift\n"
        case 1..<20: "let value\(index) = compute(\(index))\n"
        case 20: "```\n\n"
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

/// One measured run: the work it counted, its wall-clock time, and per-step detail for the report.
private struct ChatWorkSample {
    let work: [String: Int]
    let seconds: Double
    let detail: String?

    func line(run: Int) -> String {
        let counts = work.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        let summary = "run \(run): \(String(format: "%.0f", seconds * 1000)) ms \(counts)"
        return detail.map { "\(summary)\nrun \(run): \($0)" } ?? summary
    }
}
