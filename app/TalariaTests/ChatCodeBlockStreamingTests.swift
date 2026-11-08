import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// A streaming code block rebuilds only its open last lines per update (TAL-1396).
///
/// Hosts a real `ChatCodeBlock` and streams a 2,000-line fence into it in 200 updates. A finished group of 64 lines
/// must not rebuild when later lines arrive, so each update rebuilds only the group that was open before it and any
/// group it opens. While streaming, the highlight task never runs, so no fallback is logged until the stream ends.
@MainActor
final class ChatCodeBlockStreamingTests: XCTestCase {
    private static let lineCount = 2_000
    private static let updateCount = 200
    /// Lines per render group (the ticket's decided size).
    private static let groupSize = 64

    override func tearDown() {
        MainActor.assumeIsolated { ChatBodyEvaluationRecorder.installed = nil }
        super.tearDown()
    }

    func testStreamingFenceRebuildsOnlyItsOpenGroupPerUpdate() throws {
        let fence = StreamingFence()
        let recorder = ChatBodyEvaluationRecorder()
        ChatBodyEvaluationRecorder.installed = recorder
        let window = try hostWindow(ScrollView { StreamingFenceView(fence: fence) })
        let linesPerUpdate = Self.lineCount / Self.updateCount
        var fallbacks = 0

        for update in 0..<Self.updateCount {
            // Every line ends in a newline, so the block also shows one empty last line.
            let linesBefore = update * linesPerUpdate + 1
            let linesAfter = linesBefore + linesPerUpdate
            let openGroupStart = (linesBefore - 1) / Self.groupSize * Self.groupSize
            recorder.reset()
            let first = update * linesPerUpdate
            fence.content += (first..<first + linesPerUpdate).map { "let value\($0) = compute(\($0))\n" }.joined()
            XCTAssertTrue(waitUntil { recorder.counts["codeLine", default: 0] > 0 }, "Update \(update) never rendered")
            settle(0.01)
            window.layoutIfNeeded()

            let rebuilt = recorder.counts["codeLine", default: 0]
            XCTAssertLessThanOrEqual(
                rebuilt, linesAfter - openGroupStart,
                "Update \(update) rebuilt \(rebuilt) of \(linesAfter) lines; only lines from \(openGroupStart) on may change"
            )
            fallbacks += recorder.counts["highlightFallback", default: 0]
        }
        XCTAssertEqual(fallbacks, 0, "A streaming block must not log a highlight fallback")

        // The settled block is checked once: 2,001 lines exceed the highlighter's limit, so it logs one fallback.
        recorder.reset()
        fence.isStreaming = false
        XCTAssertTrue(waitUntil { recorder.counts["highlightFallback", default: 0] > 0 }, "The settled block never decided")
        settle(0.05)
        XCTAssertEqual(recorder.counts["highlightFallback", default: 0], 1)
    }
}

@MainActor
@Observable
private final class StreamingFence {
    var content = ""
    var isStreaming = true
}

private struct StreamingFenceView: View {
    let fence: StreamingFence

    var body: some View {
        ChatCodeBlock(language: "swift", content: fence.content, isStreaming: fence.isStreaming)
    }
}
