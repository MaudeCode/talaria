import SwiftData
import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Chat open budget (TAL-1678).
///
/// Opening a chat pays a per-message cost before the transcript shows: the session read is decoded, merged with the
/// cache, mapped to transcript rows and written back to the cache. The same cost recurs on every older-page prepend,
/// a cache-first open and a completed stream's reload, so it must stay linear in the messages loaded.
///
/// `testTranscriptLoadStaysLinear` times `ChatViewModel.loadMessages` reopening a cached chat, up to
/// `displayedTranscriptMessages` being populated; `testHostedOpenStaysLinear` times a hosted `ChatView` from
/// `hostWindow` until the last row's label is on screen, which adds the first layout. Both fail when the cost per
/// message grows across the curve. `ChatViewModelMergeDedupTests` owns the cache merge's scaling over a wider span.
@MainActor
final class ChatOpenPerformanceTests: XCTestCase {
    /// The span is 3x, so a linear path costs the same per message at both sizes where a quadratic one costs 3x.
    private static let sizes = [200, 600]

    /// Repeats per size; each size keeps its fastest run so an unrelated CI stall inflates no measurement.
    private static let repeatCount = 5
    private static let hostedRepeatCount = 3

    /// Per-message cost growth allowed from 200 to 600 messages.
    private static let maximumPerMessageGrowth = 2.0

    /// Ceilings on the 600-message case: the build VM measured 138 ms and 519 ms, and GitHub's hosted runner runs
    /// about four times slower, so these catch a regression that grew evenly enough to keep the ratio flat.
    private static let maximumLoadSeconds = 1.0
    private static let maximumHostedOpenSeconds = 5.0

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    /// A reopen of a cached chat: the cached transcript paints first, then the server's page is merged with it,
    /// mapped to rows and written back.
    func testTranscriptLoadStaysLinear() async throws {
        var samples: [ChatOpenSample] = []
        for count in Self.sizes {
            let fixture = try FixtureApp(for: self)
            let context = fixture.cache.mainContext
            try await makeViewModel(messageCount: count).loadMessages(modelContext: context)
            var runs: [Double] = []
            for _ in 0..<Self.repeatCount {
                let viewModel = try makeViewModel(messageCount: count)
                let start = DispatchTime.now().uptimeNanoseconds
                await viewModel.loadMessages(modelContext: context)
                runs.append(Self.seconds(since: start))
                XCTAssertEqual(viewModel.displayedTranscriptMessages.count, count, "The budget transcript did not load")
            }
            samples.append(ChatOpenSample(messageCount: count, seconds: runs.min()!))
        }
        assertLinear(samples, name: "Chat transcript load", ceiling: Self.maximumLoadSeconds)
    }

    func testHostedOpenStaysLinear() async throws {
        var samples: [ChatOpenSample] = []
        for count in Self.sizes {
            var runs: [Double] = []
            for _ in 0..<Self.hostedRepeatCount {
                let fixture = try FixtureApp(for: self)
                let viewModel = try makeViewModel(messageCount: count)
                let lastRow = ChatOpenFixture.lastRowLabel(messageCount: count)
                let start = DispatchTime.now().uptimeNanoseconds
                let window = try hostWindow(NavigationStack {
                    ChatView(session: ChatOpenFixture.summary, server: ChatOpenFixture.server, onAPIError: { _ in },
                             draftStore: fixture.environment.draftStore, viewModel: viewModel)
                }.modelContainer(fixture.cache))
                let shown = await awaitCondition(timeout: 30) {
                    !HostedAccessibility.elements(in: window, labelContaining: lastRow).isEmpty
                }
                runs.append(Self.seconds(since: start))
                XCTAssertTrue(shown, "The last row of \(count) messages never appeared")
                window.isHidden = true
            }
            samples.append(ChatOpenSample(messageCount: count, seconds: runs.min()!))
        }
        assertLinear(samples, name: "Hosted chat open", ceiling: Self.maximumHostedOpenSeconds)
    }

    private func makeViewModel(messageCount: Int) throws -> ChatViewModel {
        let session = ChatOpenFixture.sessionJSON(messageCount: messageCount)
        return try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient(),
                                             sessionSummary: ChatOpenFixture.summary,
                                             server: ChatOpenFixture.server) { request in
            request.url?.path == "/api/session"
                ? apiTestJSONResponse(session, for: request)
                : apiTestJSONResponse("{}", for: request)
        }
    }

    private func assertLinear(_ samples: [ChatOpenSample], name: String, ceiling: Double,
                              file: StaticString = #filePath, line: UInt = #line) {
        let report = ChatOpenSample.table(samples)
        let attachment = XCTAttachment(string: report)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        print("\(name)\n\(report)")

        guard let smallest = samples.first, let largest = samples.last else { return }
        let growth = largest.perMessage / max(smallest.perMessage, 1e-9)
        XCTAssertLessThanOrEqual(growth, Self.maximumPerMessageGrowth,
                                 "\(name) cost per message grew \(String(format: "%.2f", growth))x.\n\(report)",
                                 file: file, line: line)
        XCTAssertLessThan(largest.seconds, ceiling,
                          "\(name) of \(largest.messageCount) messages took \(String(format: "%.3f", largest.seconds)) s.\n\(report)",
                          file: file, line: line)
    }

    private static func seconds(since start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
    }
}

/// User and assistant messages alternate; each carries Markdown with a code span and a link.
private enum ChatOpenFixture {
    static let server = URL(string: "https://example.test")!
    static let summary = SessionSummary(sessionId: "session-open", title: "Open budget")

    static func lastRowLabel(messageCount: Int) -> String {
        "Answer \((messageCount - 1) / 2) uses"
    }

    static func sessionJSON(messageCount: Int) -> String {
        let messages = (0..<messageCount).map { index -> [String: Any] in
            let turn = index / 2
            if index.isMultiple(of: 2) {
                return ["role": "user", "message_id": "user-\(turn)",
                        "content": "Question \(turn) about `value\(turn)` and https://example.test/q/\(turn)."]
            }
            return ["role": "assistant", "message_id": "assistant-\(turn)",
                    "content": "Answer \(turn) uses `compute(\(turn))`; see [the docs](https://example.test/docs/\(turn)).\n\nIt keeps the rest as it was."]
        }
        let body: [String: Any] = ["session": ["session_id": "session-open", "title": "Open budget", "messages": messages]]
        let data = try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}

private struct ChatOpenSample {
    let messageCount: Int
    let seconds: Double
    var perMessage: Double { seconds / Double(messageCount) }

    static func table(_ samples: [Self]) -> String {
        let rows = samples.map {
            String(format: "%d\t%.1f\t%.3f", $0.messageCount, $0.seconds * 1000, $0.perMessage * 1000)
        }
        return (["messages\ttotal_ms\tper_message_ms"] + rows).joined(separator: "\n")
    }
}
