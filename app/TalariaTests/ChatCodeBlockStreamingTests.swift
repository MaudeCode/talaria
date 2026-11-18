import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// A streaming code block keeps its view across updates (TAL-1396).
///
/// Streams a 2,000-line fence into a reply's Markdown in 200 updates, through the view a streaming reply draws its
/// Markdown with. SwiftUI builds an inserted row twice, so an update may build each existing line at most once and its
/// new lines twice; a new view per update, as the Markdown renderer gave the fence, builds every line twice. Whether
/// SwiftUI also skips the finished groups, whose values stay equal (`MarkdownMathRendererTests`), is its own decision:
/// on CI (Xcode 27.1, iOS 27.0) one run re-ran every equal group on every update and the next skipped them, so this test
/// does not count on it (TAL-2535). While streaming, the highlight task never runs, so no fallback is logged until the
/// stream ends.
@MainActor
final class ChatCodeBlockStreamingTests: XCTestCase {
    private static let lineCount = 2_000
    private static let updateCount = 200

    override func tearDown() {
        MainActor.assumeIsolated { ChatBodyEvaluationRecorder.installed = nil }
        super.tearDown()
    }

    func testStreamingFenceKeepsItsViewAcrossUpdates() async throws {
        let fence = StreamingFence()
        let recorder = ChatBodyEvaluationRecorder()
        ChatBodyEvaluationRecorder.installed = recorder
        let window = try hostWindow(ScrollView { StreamingFenceView(fence: fence) })
        let scene = try XCTUnwrap(window.windowScene)
        let linesPerUpdate = Self.lineCount / Self.updateCount
        var fallbacks = 0
        var rebuiltTwice: [String] = []

        for update in 0..<Self.updateCount {
            // The renderer drops the code's last newline; an empty block still shows one line.
            let linesBefore = max(update * linesPerUpdate, 1)
            let linesAfter = (update + 1) * linesPerUpdate
            recorder.reset()
            let first = update * linesPerUpdate
            fence.content += (first..<first + linesPerUpdate).map { "let value\($0) = compute(\($0))\n" }.joined()
            let rendered = await awaitCondition { recorder.counts["codeLine", default: 0] > 0 }
            XCTAssertTrue(rendered, "Update \(update) never rendered")
            // The update's remaining groups render by the next drawn frame.
            await awaitDisplayUpdates(2, in: scene)
            window.layoutIfNeeded()

            let rebuilt = recorder.counts["codeLine", default: 0]
            if rebuilt > linesAfter + (linesAfter - linesBefore) {
                rebuiltTwice.append("\(update): \(rebuilt) of \(linesAfter)")
            }
            fallbacks += recorder.counts["highlightFallback", default: 0]
        }
        XCTAssertEqual(rebuiltTwice, [], "Updates that built existing lines again as new views")
        XCTAssertEqual(fallbacks, 0, "A streaming block must not log a highlight fallback")

        // The settled block decides once: `text` is never highlighted, so it logs one fallback.
        recorder.reset()
        fence.isStreaming = false
        let decided = await awaitCondition { recorder.counts["highlightFallback", default: 0] > 0 }
        XCTAssertTrue(decided, "The settled block never decided")
        await awaitDisplayUpdates(2, in: scene)
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
