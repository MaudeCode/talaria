import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// A streaming code block rebuilds only its open last lines per update (TAL-1396).
///
/// Streams a 2,000-line fence into a reply's Markdown in 200 updates, through the view a streaming reply draws its
/// Markdown with, so the code block must also keep its identity across updates. A finished group of 64 lines
/// must not rebuild when later lines arrive, so each update rebuilds only the group that was open before it and any
/// group it opens. SwiftUI builds each inserted line twice, once more than a changed one, so the bound allows the
/// update's new lines once more. While streaming, the highlight task never runs, so no fallback is logged until the
/// stream ends.
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

    func testStreamingFenceRebuildsOnlyItsOpenGroupPerUpdate() async throws {
        let fence = StreamingFence()
        let recorder = ChatBodyEvaluationRecorder()
        ChatBodyEvaluationRecorder.installed = recorder
        let window = try hostWindow(ScrollView { StreamingFenceView(fence: fence) })
        // A loaded CI runner keeps re-rendering a freshly mounted block for about a second, as the chat budget sees
        // after a send; measure only once it has stopped.
        let quiet = await awaitQuiet { recorder.counts.values.reduce(0, +) }
        XCTAssertNotNil(quiet, "The block must stop re-rendering after it mounts before measuring")
        let linesPerUpdate = Self.lineCount / Self.updateCount
        var fallbacks = 0

        for update in 0..<Self.updateCount {
            // The renderer drops the code's last newline; an empty block still shows one line.
            let linesBefore = max(update * linesPerUpdate, 1)
            let linesAfter = (update + 1) * linesPerUpdate
            let openGroupStart = (linesBefore - 1) / Self.groupSize * Self.groupSize
            recorder.reset()
            let first = update * linesPerUpdate
            fence.content += (first..<first + linesPerUpdate).map { "let value\($0) = compute(\($0))\n" }.joined()
            let rendered = await awaitCondition { recorder.counts["codeLine", default: 0] > 0 }
            XCTAssertTrue(rendered, "Update \(update) never rendered")
            try await Task.sleep(for: .milliseconds(10))
            window.layoutIfNeeded()

            let rebuilt = recorder.counts["codeLine", default: 0]
            XCTAssertLessThanOrEqual(
                rebuilt, linesAfter - openGroupStart + linesPerUpdate,
                "Update \(update) rebuilt \(rebuilt) of \(linesAfter) lines; only lines from \(openGroupStart) on may change"
            )
            print("DIAG update \(update): \(recorder.counts.filter { $0.key.hasPrefix("diag") }.sorted { $0.key < $1.key })")
            fallbacks += recorder.counts["highlightFallback", default: 0]
        }
        XCTAssertEqual(fallbacks, 0, "A streaming block must not log a highlight fallback")

        // The settled block decides once: `text` is never highlighted, so it logs one fallback.
        recorder.reset()
        fence.isStreaming = false
        let decided = await awaitCondition { recorder.counts["highlightFallback", default: 0] > 0 }
        XCTAssertTrue(decided, "The settled block never decided")
        try await Task.sleep(for: .milliseconds(50))
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
        ChatMarkdownView(content: "Here is the file.\n\n```text\n" + fence.content, colorScheme: .light,
                         isStreaming: fence.isStreaming)
    }
}
