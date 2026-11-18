import SwiftUI
import XCTest
@testable import TalariaKit

/// Streaming reveal tests (TAL-1410): each coalesced tick shows every buffered
/// complete word, a trailing fragment waits one tick, and completion paths flush instantly.
final class ChatViewModelStreamingPaceTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    /// TAL-1410: a received burst of complete words shows whole on the first coalesced tick.
    @MainActor
    func testCompleteWordBurstShowsWholeOnFirstTick() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient, coalescingDelayNanoseconds: 60_000_000_000)
        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        let burst = (0..<100).map { "w\($0) " }.joined()
        streamClient.emit(.token(burst))
        viewModel.revealStreamingContentTickForTesting()

        XCTAssertEqual(assistantContent(of: viewModel), burst)
        XCTAssertEqual(viewModel.displayedTranscriptMessages.last?.message.content, burst)
    }

    /// TAL-1410: a cancelled tick that resumes late must not free the slot a newer tick owns.
    @MainActor
    func testCancelledTickResumingLateLeavesTheNewerTickScheduled() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient, coalescingDelayNanoseconds: 60_000_000_000)
        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("alpha "))
        let staleTick = try XCTUnwrap(viewModel.pendingStreamingContentFlushTaskForTesting)
        viewModel.revealStreamingContentTickForTesting()
        streamClient.emit(.token("beta "))
        let newerTick = try XCTUnwrap(viewModel.pendingStreamingContentFlushTaskForTesting)
        XCTAssertNotEqual(staleTick, newerTick)

        await staleTick.value

        XCTAssertEqual(viewModel.pendingStreamingContentFlushTaskForTesting, newerTick)
    }

    /// TAL-1410: a trailing partial word waits one tick, then shows even without whitespace.
    @MainActor
    func testTrailingFragmentIsHeldForOneTickOnly() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)
        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("alpha beta gam"))
        viewModel.revealStreamingContentTickForTesting()
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta ")

        viewModel.revealStreamingContentTickForTesting()
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta gam")

        streamClient.emit(.token("ma delta"))
        viewModel.revealStreamingContentTickForTesting()
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta gamma ")
    }

    /// TAL-1410: text with no whitespace (CJK, URLs, code, emoji) shows exactly on the following tick.
    @MainActor
    func testWhitespaceFreeTextShowsExactlyOnTheFollowingTick() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)
        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        let text = "東京で会いましょう👩‍👩‍👧‍👦https://example.test/a_b?c=d`x=[1,2]`cafe\u{301}"
        streamClient.emit(.token(text))
        viewModel.revealStreamingContentTickForTesting()
        XCTAssertEqual(assistantContent(of: viewModel) ?? "", "")

        viewModel.revealStreamingContentTickForTesting()
        XCTAssertEqual(Array(try XCTUnwrap(assistantContent(of: viewModel)).utf8), Array(text.utf8))
    }

    @MainActor
    func testPacedContentUpdatesOnlyTheStreamingTranscriptRow() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            heldFragmentDelayNanoseconds: 10_000_000
        )

        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("alpha "))
        _ = try await observeAssistantContent(viewModel, until: "alpha ")
        let recomputeCount = viewModel.displayedTranscriptRecomputeCount

        streamClient.emit(.token("beta"))
        _ = try await observeAssistantContent(viewModel, until: "alpha beta")

        XCTAssertEqual(viewModel.displayedTranscriptRecomputeCount, recomputeCount)
        XCTAssertEqual(viewModel.displayedTranscriptMessages.last?.message.content, "alpha beta")
    }

    /// TAL-855: reasoning cards are derived when the transcript changes and published only when they differ.
    @MainActor
    func testReasoningCardsUpdateOnceForANewReasoningReplyAndNotPerStreamTick() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            heldFragmentDelayNanoseconds: 1_000_000,
            sessionMessages: Self.reasoningTranscript(turns: 1)
        )
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.displayedReasoningGroups.map(\.anchorMessageID), ["assistant-0"])
        XCTAssertEqual(viewModel.reasoningGroupsForAnchor("assistant-0").map(\.text), ["Weigh question 0."])
        let loadedUpdates = viewModel.displayedReasoningGroupsUpdateCount

        let didStart = await viewModel.sendMessage("Question 1")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("alpha "))
        _ = try await observeAssistantContent(viewModel, until: "alpha ")
        streamClient.emit(.token("beta"))
        _ = try await observeAssistantContent(viewModel, until: "alpha beta")
        XCTAssertEqual(viewModel.displayedReasoningGroupsUpdateCount, loadedUpdates,
                       "A send and its stream ticks leave the reasoning cards alone")

        streamClient.emit(.done(DoneStreamEvent()))
        streamClient.emit(.streamEnd)
        try await waitUntil { await viewModel.activeStreamID == nil }
        XCTAssertEqual(viewModel.displayedReasoningGroupsUpdateCount, loadedUpdates)
        stubSession(messages: Self.reasoningTranscript(turns: 2))
        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.displayedReasoningGroupsUpdateCount, loadedUpdates + 1,
                       "The reply carrying new reasoning publishes the cards once")
        XCTAssertEqual(viewModel.displayedReasoningGroups.map(\.anchorMessageID), ["assistant-0", "assistant-1"])
        XCTAssertEqual(viewModel.reasoningGroupsForAnchor("assistant-1").map(\.text), ["Weigh question 1."])
        XCTAssertEqual(viewModel.reasoningGroupsForAnchor(nil), [])
    }

    /// TAL-1242: the transcript keys its reading-place hold on `excerptRevision`, so it bumps once per excerpt change
    /// and never for a stream tick that changes only the trailing message's text.
    @MainActor
    func testExcerptRevisionBumpsPerExcerptChangeAndNotPerStreamTick() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient, coalescingDelayNanoseconds: 60_000_000_000,
                                          sessionMessages: Self.excerptTranscript(truncated: false))
        await viewModel.loadMessages()
        let loadedRevision = viewModel.excerptRevision

        stubSession(messages: Self.excerptTranscript(truncated: true))
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.messages.last?.displayExcerpt, "Long")
        XCTAssertEqual(viewModel.excerptRevision, loadedRevision + 1, "One excerpt change bumps the revision once")

        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("w "))
        viewModel.revealStreamingContentTickForTesting()
        let streamingRevision = viewModel.excerptRevision
        for tick in 0..<100 {
            streamClient.emit(.token("t\(tick) "))
            viewModel.revealStreamingContentTickForTesting()
        }

        XCTAssertEqual(assistantContent(of: viewModel), "w " + (0..<100).map { "t\($0) " }.joined())
        XCTAssertEqual(viewModel.excerptRevision, streamingRevision, "Text-only stream ticks change no excerpt")
    }

    @MainActor
    func testDoneEventFlushesRemainingBufferImmediately() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)

        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("alpha beta gamma"))
        _ = try await observeAssistantContent(viewModel, until: "alpha beta ")
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta ")

        streamClient.emit(.done(DoneStreamEvent()))
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta gamma")

        // Nothing may trickle in after completion.
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta gamma")
    }

    @MainActor
    func testToolBoundaryPreservesBufferedProseOrderThroughCompletion() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)

        let didStart = await viewModel.sendMessage("Watch the cluster")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("I'm watching "))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool",
            name: "cluster",
            preview: nil,
            args: nil,
            duration: nil,
            isError: nil,
            stableID: "call-1"
        )))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "tools"])

        streamClient.emit(.token("k8s-ceous come back."))
        streamClient.emit(.done(DoneStreamEvent()))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "tools", "prose"])
        XCTAssertEqual(
            viewModel.liveActivityRows.compactMap(\.text),
            ["I'm watching ", "k8s-ceous come back."]
        )
    }

    @MainActor
    func testCompletionWithoutStartPreservesBufferedProseOrder() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)

        let didStart = await viewModel.sendMessage("Recover the tool result")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Before tool. "))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool_complete",
            name: "cluster",
            preview: "Recovered",
            args: nil,
            duration: 0.2,
            isError: false,
            stableID: "call-1"
        )))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "tools"])
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)
    }

    @MainActor
    func testReasoningBoundariesPreserveBufferedArrivalOrder() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)

        let didStart = await viewModel.sendMessage("Think between updates")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Before reasoning. "))
        streamClient.emit(.reasoning("Check the state."))
        streamClient.emit(.token("After reasoning."))
        streamClient.emit(.done(DoneStreamEvent()))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "reasoning", "prose"])
        XCTAssertEqual(
            viewModel.liveActivityRows.compactMap(\.text),
            ["Before reasoning. ", "Check the state.", "After reasoning."]
        )
    }

    @MainActor
    func testCancelledEventFlushesRemainingBufferImmediately() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeStalledDrainViewModel(streamClient: streamClient)

        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("alpha beta gamma"))
        _ = try await observeAssistantContent(viewModel, until: "alpha beta ")
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta ")

        streamClient.emit(.cancelled)
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta gamma")

        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(assistantContent(of: viewModel), "alpha beta gamma")
    }

    @MainActor
    func testPacedContentConvergesByteIdenticalToUnpacedJoin() async throws {
        let streamClient = PacingSpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            heldFragmentDelayNanoseconds: 1_000_000
        )

        let didStart = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(didStart)

        // Awkward chunk boundaries: ZWJ family, flag, CRLF, tabs, doubled spaces,
        // and a combining mark split across chunks ("cafe" + U+0301).
        let chunks = [
            "The 👩‍👩‍👧‍👦 family ",
            "and 🇫🇷 flag met.\r\n",
            "tabs\tand  doubles ",
            "cafe",
            "\u{301} fin"
        ]
        for chunk in chunks {
            streamClient.emit(.token(chunk))
        }

        let target = chunks.joined()
        _ = try await observeAssistantContent(viewModel, until: target)
        let content = try XCTUnwrap(assistantContent(of: viewModel))
        XCTAssertEqual(
            Array(content.utf8),
            Array(target.utf8),
            "paced content must converge byte-identical to the unpaced concatenation"
        )
    }

    // MARK: - Helpers

    /// The first tick shows the complete words, then a 60s held-fragment delay
    /// stalls the reveal so completion-path flushes are observable.
    @MainActor
    private func makeStalledDrainViewModel(
        streamClient: PacingSpySSEStreamingClient
    ) throws -> ChatViewModel {
        try makeViewModel(
            streamClient: streamClient,
            heldFragmentDelayNanoseconds: 60_000_000_000
        )
    }

    @MainActor
    private func makeViewModel(
        streamClient: PacingSpySSEStreamingClient,
        coalescingDelayNanoseconds: UInt64 = 1_000_000,
        heldFragmentDelayNanoseconds: UInt64 = 48_000_000,
        sessionMessages: String = "[]"
    ) throws -> ChatViewModel {
        stubSession(messages: sessionMessages)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = APIClient(baseURL: server, session: urlSession)

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let summary = try decoder.decode(
            SessionSummary.self,
            from: Data(
                #"{"session_id": "session-abc", "title": "Pacing", "workspace": "/tmp/workspace"}"#.utf8
            )
        )

        return ChatViewModel(
            session: summary,
            server: server,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: PacingSpySSEStreamingClient(),
            clarifyStreamClient: PacingSpySSEStreamingClient(),
            liveActivityManager: SpyChatLiveActivityManager(),
            streamingScrollCoalescingDelayNanoseconds: coalescingDelayNanoseconds,
            streamingHeldFragmentRevealDelayNanoseconds: heldFragmentDelayNanoseconds
        )
    }

    /// Serves `messages` (a JSON array) as the session transcript.
    private func stubSession(messages: String) {
        MockURLProtocol.requestHandler = { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(
                    #"{"session_id": "session-abc", "stream_id": "stream-123"}"#,
                    for: request
                )
            default:
                return apiTestJSONResponse(
                    #"{"session": {"session_id": "session-abc", "title": "Pacing", "messages": \#(messages)}}"#,
                    for: request
                )
            }
        }
    }

    /// `turns` question-and-answer pairs, each answer carrying its own reasoning.
    private static func reasoningTranscript(turns: Int) -> String {
        let rows = (0..<turns).map { turn in
            #"{"role": "user", "content": "Question \#(turn)", "message_id": "user-\#(turn)"}, "#
                + #"{"role": "assistant", "content": "Answer \#(turn).", "message_id": "assistant-\#(turn)", "#
                + #""reasoning": "Weigh question \#(turn)."}"#
        }
        return "[\(rows.joined(separator: ", "))]"
    }

    /// A question and a long answer the server sends whole or folded to an excerpt.
    private static func excerptTranscript(truncated: Bool) -> String {
        let fold = truncated ? #", "_display_truncated": true, "_display_excerpt": "Long""# : ""
        return #"[{"role": "user", "content": "Question", "message_id": "user-0"}, "#
            + #"{"role": "assistant", "content": "Long answer.", "message_id": "assistant-0"\#(fold)}]"#
    }

    @MainActor
    private func assistantContent(of viewModel: ChatViewModel) -> String? {
        viewModel.messages.last(where: { $0.role == "assistant" })?.content
    }

    /// Polls assistant content every 5ms until it equals `target` (or times out),
    /// returning every distinct non-empty value observed in order.
    @MainActor
    private func observeAssistantContent(
        _ viewModel: ChatViewModel,
        until target: String,
        timeoutNanoseconds: UInt64 = 4_000_000_000,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> [String] {
        let pollNanoseconds: UInt64 = 5_000_000
        var observed: [String] = []
        var elapsed: UInt64 = 0
        while elapsed <= timeoutNanoseconds {
            if let content = assistantContent(of: viewModel), !content.isEmpty,
               observed.last != content {
                observed.append(content)
            }
            if observed.last == target {
                return observed
            }

            try await Task.sleep(nanoseconds: pollNanoseconds)
            elapsed += pollNanoseconds
        }

        XCTFail(
            "timed out waiting for \(target); observed: \(observed)",
            file: file,
            line: line
        )
        return observed
    }
}

/// Issue #214: the streaming bottom-follow scroll and active-row growth share
/// one short cadence-synced animation, disabled entirely under Reduce Motion.
final class ChatStreamingMotionTests: XCTestCase {
    func testStreamingFollowUsesShortEaseOut() {
        XCTAssertEqual(
            ChatMotion.streamingFollow(reduceMotion: false),
            .easeOut(duration: 0.15)
        )
    }

    func testStreamingFollowIsDisabledUnderReduceMotion() {
        XCTAssertNil(ChatMotion.streamingFollow(reduceMotion: true))
    }
}

private final class PacingSpySSEStreamingClient: SSEStreamingClient {
    private(set) var lastEventID: String?
    private var onEvent: (@MainActor (SSEEvent) -> Void)?

    func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        lastEventID = nil
        self.onEvent = onEvent
    }

    func stop() {}

    @MainActor
    func emit(_ event: SSEEvent) {
        onEvent?(event)
    }
}
