import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria

@MainActor
extension ChatViewModelSendTests {
    func testLiveStreamEventsUpdateTranscriptBeforeCompletion() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")

        streamClient.emit(.reasoning(ReasoningStreamEvent(
            text: "I need to inspect the workspace.",
            titles: ["Planning workspace inspection"]
        )))
        streamClient.emit(.reasoning(ReasoningStreamEvent(
            text: "",
            titles: ["Inspecting files"]
        )))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "read_file",
            preview: "Reading PROJECT_SPEC.md",
            args: ["path": .string("PROJECT_SPEC.md")],
            duration: nil,
            isError: nil,
            stableID: "call-read-spec"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool.completed",
            name: "read_file",
            preview: "Read PROJECT_SPEC.md",
            args: ["path": .string("PROJECT_SPEC.md")],
            duration: 0.25,
            isError: false,
            stableID: "call-read-spec"
        )))
        streamClient.emit(.token("First live token."))

        XCTAssertEqual(viewModel.liveReasoningText, "I need to inspect the workspace.")
        guard case .reasoning(let reasoning) = viewModel.liveActivityRows.first?.content else {
            return XCTFail("Expected live reasoning metadata")
        }
        XCTAssertEqual(reasoning.titles, ["Inspecting files"])
        XCTAssertEqual(viewModel.liveToolCalls.count, 1)
        XCTAssertEqual(viewModel.liveToolCalls.first?.name, "read_file")
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)
        XCTAssertEqual(viewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(viewModel.messages.last?.content, "First live token.")
        XCTAssertNotNil(viewModel.streamingAssistantMessageID)
        XCTAssertFalse(viewModel.responseCompletionHapticTrigger > 0)
    }

    @MainActor
    func testSameNameToolsSettleByServerIDWhenTheyFinishOutOfOrder() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {"session_id":"session-abc","stream_id":"stream-123"}
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Run both")
        XCTAssertTrue(didStart)

        func started(_ id: String, _ command: String) -> SSEEvent {
            .toolStarted(ToolStreamEvent(
                eventType: "tool",
                name: "terminal",
                preview: command,
                args: ["command": .string(command)],
                duration: nil,
                isError: nil,
                stableID: id
            ))
        }
        func completed(_ id: String, _ preview: String, _ duration: Double, _ isError: Bool) -> SSEEvent {
            .toolCompleted(ToolStreamEvent(
                eventType: "tool_complete",
                name: "terminal",
                preview: preview,
                args: nil,
                duration: duration,
                isError: isError,
                stableID: id
            ))
        }
        let events = [
            started("call-a", "make a"),
            started("call-b", "make b"),
            completed("call-b", "b passed", 0.2, false),
            completed("call-a", "a failed", 1.5, true)
        ]
        // The second pass is a reconnect replaying the journal from the start.
        for _ in 0..<2 {
            for (offset, event) in events.enumerated() {
                streamClient.emit(event, lastEventID: "stream-123:\(offset + 1)")
            }
        }

        XCTAssertEqual(viewModel.liveToolCalls.map(\.id), ["call-a", "call-b"])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.preview), ["a failed", "b passed"])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.duration), [1.5, 0.2])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.isError), [true, false])
        XCTAssertEqual(viewModel.liveToolCalls.map(\.isCompleted), [true, true])
    }

    func testReasoningAndToolEventsAnchorToStableAssistantTurnBeforeFirstToken() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Use tools before answering")
        XCTAssertTrue(didStart)

        streamClient.emit(.reasoning("I should inspect the workspace."))

        let liveAssistantID = try XCTUnwrap(viewModel.streamingAssistantMessageID)
        XCTAssertEqual(viewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(viewModel.messages.last?.messageId, liveAssistantID)
        XCTAssertEqual(viewModel.messages.last?.content, "")
        XCTAssertEqual(viewModel.reasoningAnchorMessageID, liveAssistantID)
        XCTAssertFalse(viewModel.hasStreamingAssistantMessageContent)

        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "terminal",
            preview: "pwd",
            args: ["cmd": .string("pwd")],
            duration: nil,
            isError: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.streamingAssistantMessageID, liveAssistantID)
        XCTAssertEqual(viewModel.toolCallAnchorMessageID, liveAssistantID)
        XCTAssertEqual(viewModel.liveToolCalls.map(\.name), ["terminal"])

        streamClient.emit(.token("Live answer starts now."))

        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.streamingAssistantMessageID, liveAssistantID)
        XCTAssertEqual(viewModel.messages.last?.messageId, liveAssistantID)
        XCTAssertEqual(viewModel.messages.last?.content, "Live answer starts now.")
        XCTAssertTrue(viewModel.hasStreamingAssistantMessageContent)
    }

    @MainActor
    func testLiveStreamScrollTriggerCoalescesRapidUpdates() async throws {
        let streamClient = SpySSEStreamingClient()
        streamClient.automaticallyFlushPendingStreamingContent = false
        // Inject a tiny coalescing window. Determinism comes from flushing
        // synchronously and awaiting the pending scroll-trigger task below, not from
        // this value; a small delay just keeps those awaits fast. The production
        // default (16ms) is exercised everywhere else.
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            streamingScrollCoalescingDelayNanoseconds: 1_000_000
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Stream a long response")
        XCTAssertTrue(didStart)

        // sendMessage's optimistic user-message append schedules a coalesced scroll
        // trigger. Settle it so the increments measured below come only from the
        // streaming bursts — this is the task that used to race the real 16ms window
        // before the synchronous assertion ran.
        await viewModel.awaitPendingStreamingScrollTriggerForTesting()
        let initialTrigger = viewModel.streamingScrollTrigger

        // Burst 1: 20 rapid tokens batch behind a single coalesced flush. Nothing has
        // scrolled yet at this synchronous point — no await has elapsed since the
        // burst, regardless of CPU load.
        for index in 0..<20 {
            streamClient.emit(.token("token-\(index) "))
        }
        XCTAssertEqual(viewModel.streamingScrollTrigger, initialTrigger)

        // Flushing the batch schedules exactly one (still-deferred) scroll trigger;
        // draining it advances the trigger by exactly one — not 20 — proving the
        // 20-token burst coalesced into a single scroll.
        viewModel.flushPendingStreamingContent()
        XCTAssertEqual(viewModel.streamingScrollTrigger, initialTrigger)
        await viewModel.awaitPendingStreamingScrollTriggerForTesting()
        XCTAssertEqual(viewModel.streamingScrollTrigger, initialTrigger + 1)
        XCTAssertTrue(viewModel.messages.last?.content?.hasPrefix("token-0 token-1") == true)

        // Burst 2: a distinct, heterogeneous reasoning + tool-start burst. Flushing
        // the batched reasoning while the tool-start scroll trigger is still pending
        // exercises the production coalescing guard (one pending trigger at a time),
        // so the whole burst collapses into exactly one more increment regardless of
        // task scheduling order.
        streamClient.emit(.reasoning("Check the next step."))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "read_file",
            preview: "Reading README.md",
            args: ["path": .string("README.md")],
            duration: nil,
            isError: nil
        )))
        XCTAssertEqual(viewModel.streamingScrollTrigger, initialTrigger + 1)
        viewModel.flushPendingStreamingContent()
        XCTAssertEqual(viewModel.streamingScrollTrigger, initialTrigger + 1)
        await viewModel.awaitPendingStreamingScrollTriggerForTesting()
        XCTAssertEqual(viewModel.streamingScrollTrigger, initialTrigger + 2)
    }

    @MainActor
    func testDisplayedTranscriptMessagesMemoMatchesPureMappingAcrossAppendsAndEdits() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        func assertMemoMatchesPureMapping(_ message: String, line: UInt = #line) {
            XCTAssertEqual(
                viewModel.displayedTranscriptMessages,
                ChatViewModel.transcriptMessages(
                    from: viewModel.messages,
                    messageOffset: viewModel.messagesOffset
                ),
                message,
                line: line
            )
        }

        // Empty transcript before any work.
        assertMemoMatchesPureMapping("memo should match for an empty transcript")

        // Append: optimistic user message + streaming assistant turn.
        let didStart = await viewModel.sendMessage("Stream a long response")
        XCTAssertTrue(didStart)
        assertMemoMatchesPureMapping("memo should match after the optimistic append")

        // Edit: streaming tokens mutate the assistant message content in place.
        streamClient.emit(.token("first chunk "))
        viewModel.flushPendingStreamingContent()
        XCTAssertTrue(viewModel.messages.last?.content?.contains("first chunk") == true)
        assertMemoMatchesPureMapping("memo should match after a streaming content edit")

        // Further edit: a second flush updates the same message again.
        streamClient.emit(.token("second chunk "))
        viewModel.flushPendingStreamingContent()
        assertMemoMatchesPureMapping("memo should match after a second content edit")
    }

    @MainActor
    func testInterimAssistantEventUpdatesTranscriptBeforeCompletion() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Use the project skill")
        XCTAssertTrue(didStart)

        streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(
            text: "Inspecting repo structure.",
            alreadyStreamed: false
        )))

        XCTAssertEqual(viewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(viewModel.messages.last?.content, "Inspecting repo structure.")
        XCTAssertNotNil(viewModel.streamingAssistantMessageID)
        XCTAssertFalse(viewModel.responseCompletionHapticTrigger > 0)
    }

    @MainActor
    func testLoadMessagesClearsPendingStreamingBuffersBeforeReload() async throws {
        let streamClient = SpySSEStreamingClient()
        streamClient.automaticallyFlushPendingStreamingContent = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "active_stream_id": "stream-123",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "From server.",
                        "timestamp": 1770000101,
                        "message_id": "assistant-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)

        for index in 0..<5 {
            streamClient.emit(.token("buffered-\(index) "))
        }

        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 1)
        XCTAssertEqual(viewModel.messages.last?.content, "From server.")

        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.count, 1)
        XCTAssertEqual(viewModel.messages.last?.content, "From server.")
    }

    @MainActor
    func testLoadMessagesDuringActiveStreamPreservesLiveStateWhenServerSnapshotIsStale() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)

        streamClient.emit(.reasoning("I need to inspect the workspace."))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "read_file",
            preview: "Reading README.md",
            args: ["path": .string("README.md")],
            duration: nil,
            isError: nil
        )))
        streamClient.emit(.token("Partial live answer."))

        let liveAssistantID = try XCTUnwrap(viewModel.streamingAssistantMessageID)

        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(viewModel.liveReasoningText, "I need to inspect the workspace.")
        XCTAssertEqual(viewModel.liveToolCalls.map(\.name), ["read_file"])
        XCTAssertEqual(viewModel.streamingAssistantMessageID, liveAssistantID)
        XCTAssertEqual(viewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(viewModel.messages.last?.content, "Partial live answer.")
    }

    @MainActor
    func testTransportReconnectUsesReplayWhenInactiveStreamHasJournal() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": false,
                  "stream_id": "stream-123",
                  "replay_available": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Partial live answer."), lastEventID: "stream-123:4")
        streamClient.emit(.transportError("lost connection"), lastEventID: "stream-123:4")

        try await waitUntil {
            streamClient.startedURLs.count == 2
        }

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let replayQueryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(replayQueryItems.first(where: { $0.name == "stream_id" })?.value, "stream-123")
        XCTAssertEqual(replayQueryItems.first(where: { $0.name == "replay" })?.value, "1")
        XCTAssertEqual(replayQueryItems.first(where: { $0.name == "after_seq" })?.value, "4")
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    func testReopenedInactiveStreamReplayUsesRestoredSnapshotEventID() {
        runMainActorTest {
            ChatViewModel.resetActiveStreamSnapshotsForTesting()
            defer { ChatViewModel.resetActiveStreamSnapshotsForTesting() }
            let originalStreamClient = SpySSEStreamingClient()
            let originalViewModel = try self.makeViewModel(streamClient: originalStreamClient) { request in
                XCTAssertEqual(request.url?.path, "/api/chat/start")
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            }

            let didStart = await originalViewModel.sendMessage("Keep working")
            XCTAssertTrue(didStart)
            originalStreamClient.emit(.token("Partial live answer."), lastEventID: "stream-123:9")
            originalViewModel.suspendStreamForNavigation()

            let reopenedStreamClient = SpySSEStreamingClient()
            let reopenedViewModel = try self.makeViewModel(streamClient: reopenedStreamClient) { request in
                switch request.url?.path {
                case "/api/session":
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "title": "Planning",
                        "active_stream_id": "stream-123",
                        "messages": [
                          {
                            "role": "user",
                            "content": "Keep working",
                            "timestamp": 1770000100,
                            "message_id": "user-1"
                          }
                        ]
                      }
                    }
                    """, for: request)
                case "/api/chat/stream/status":
                    return apiTestJSONResponse("""
                    {
                      "active": false,
                      "stream_id": "stream-123",
                      "replay_available": true
                    }
                    """, for: request)
                default:
                    XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                    throw URLError(.badURL)
                }
            }

            await reopenedViewModel.loadMessages()
            await reopenedViewModel.reconnectStreamIfNeeded()

            let replayURL = try XCTUnwrap(reopenedStreamClient.startedURLs.last)
            let replayQueryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(replayQueryItems.first(where: { $0.name == "stream_id" })?.value, "stream-123")
            XCTAssertEqual(replayQueryItems.first(where: { $0.name == "replay" })?.value, "1")
            XCTAssertEqual(replayQueryItems.first(where: { $0.name == "after_seq" })?.value, "9")
            XCTAssertEqual(reopenedViewModel.messages.compactMap(\.content), ["Keep working", "Partial live answer."])
        }
    }

    @MainActor
    func testActiveStreamStatusRefreshReloadsTranscriptWhenSSECompletionIsMissed() async throws {
        let streamClient = SpySSEStreamingClient()
        var didRequestStatus = false
        var didReloadMessages = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                didRequestStatus = true
                return apiTestJSONResponse("""
                {
                  "active": false,
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                didReloadMessages = true
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "Final answer loaded without leaving the chat.",
                        "timestamp": 1770000110,
                        "message_id": "assistant-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Keep working"])

        await viewModel.refreshTranscriptIfActiveStreamCompleted(streamID: "stream-123")

        XCTAssertTrue(didRequestStatus)
        XCTAssertTrue(didReloadMessages)
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Keep working",
            "Final answer loaded without leaving the chat."
        ])
    }

    @MainActor
    func testActiveStreamStatusRefreshWaitsForFinalTranscriptBeforeStoppingStream() async throws {
        let streamClient = SpySSEStreamingClient()
        var sessionReloadCount = 0
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse("""
                {
                  "active": false,
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                sessionReloadCount += 1
                if sessionReloadCount == 1 {
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "title": "Planning",
                        "messages": [
                          {
                            "role": "user",
                            "content": "Keep working",
                            "timestamp": 1770000100,
                            "message_id": "user-1"
                          }
                        ]
                      }
                    }
                    """, for: request)
                }

                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "Final answer arrived after the stream was marked inactive.",
                        "timestamp": 1770000110,
                        "message_id": "assistant-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Partial live answer."))

        await viewModel.refreshTranscriptIfActiveStreamCompleted(streamID: "stream-123")

        XCTAssertEqual(sessionReloadCount, 1)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Keep working",
            "Partial live answer."
        ])

        await viewModel.refreshTranscriptIfActiveStreamCompleted(streamID: "stream-123")

        XCTAssertEqual(sessionReloadCount, 2)
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Keep working",
            "Final answer arrived after the stream was marked inactive."
        ])
    }

    func testActiveStreamStatusRefreshTreatsToolOnlyAssistantAsCompletedResponse() {
        runMainActorTest {
            let streamClient = SpySSEStreamingClient()
            let viewModel = try self.makeViewModel(streamClient: streamClient) { request in
                switch request.url?.path {
                case "/api/chat/start":
                    return apiTestJSONResponse("""
                    {
                      "session_id": "session-abc",
                      "stream_id": "stream-123"
                    }
                    """, for: request)
                case "/api/chat/stream/status":
                    return apiTestJSONResponse("""
                    {
                      "active": false,
                      "stream_id": "stream-123"
                    }
                    """, for: request)
                case "/api/session":
                    return apiTestJSONResponse("""
                    {
                      "session": {
                        "session_id": "session-abc",
                        "title": "Planning",
                        "messages": [
                          {
                            "role": "user",
                            "content": "Run terminal",
                            "timestamp": 1770000100,
                            "message_id": "user-1"
                          },
                          {
                            "role": "assistant",
                            "content": "",
                            "timestamp": 1770000110,
                            "message_id": "assistant-tool",
                            "tool_calls": [
                              {
                                "id": "functions.terminal:1",
                                "function": {
                                  "name": "terminal",
                                  "arguments": "{\\"command\\":\\"pwd\\"}"
                                }
                              }
                            ]
                          },
                          {
                            "role": "tool",
                            "content": "/Users/hermes",
                            "timestamp": 1770000111,
                            "message_id": "tool-1",
                            "tool_call_id": "functions.terminal:1"
                          }
                        ]
                      }
                    }
                    """, for: request)
                default:
                    XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                    throw URLError(.badURL)
                }
            }

            let didStart = await viewModel.sendMessage("Run terminal")
            XCTAssertTrue(didStart)

            await viewModel.refreshTranscriptIfActiveStreamCompleted(streamID: "stream-123")

            XCTAssertNil(viewModel.activeStreamID)
            XCTAssertEqual(streamClient.stopCount, 1)
            XCTAssertEqual(viewModel.messages.compactMap(\.role), ["user", "assistant", "tool"])
            XCTAssertEqual(viewModel.messages.first(where: { $0.role == "assistant" })?.toolCalls?.count, 1)
        }
    }

    @MainActor
    func testAlreadyStreamedInterimAssistantDoesNotDuplicateTokenText() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Explain this")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Inspecting repo structure."))
        streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(
            text: "Inspecting repo structure.",
            alreadyStreamed: true
        )))

        XCTAssertEqual(viewModel.messages.last?.content, "Inspecting repo structure.")
    }

    @MainActor
    func testDoneSessionReconcilesTranscriptAfterApprovalResume() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Do it one more time")
        XCTAssertTrue(didStart)

        streamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                approvalId: "approval-1",
                command: "curl https://example.test/install.sh | bash",
                description: "Approval required",
                patternKey: "network_download"
            ),
            pendingCount: 1
        )))
        streamClient.emit(.token("Same"))

        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "title": "Approval test",
          "messages": [
            {
              "role": "user",
              "content": "Do it one more time",
              "message_id": "user-1"
            },
            {
              "role": "assistant",
              "content": "Same result -- approval gate triggered, then the usual JSON-is-not-bash errors.",
              "message_id": "assistant-1"
            }
          ]
        }
        """)
        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertNil(viewModel.approvalPrompt)
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(viewModel.displayTitle, "Approval test")
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Do it one more time",
            "Same result -- approval gate triggered, then the usual JSON-is-not-bash errors."
        ])
        XCTAssertEqual(viewModel.messages.last?.messageId, "assistant-1")
    }

    func testCompletedStreamSessionDoesNotRequireFollowUpTranscriptRefresh() {
        runMainActorTest {
            let streamClient = SpySSEStreamingClient()
            let viewModel = try self.makeViewModel(streamClient: streamClient) { request in
                XCTAssertEqual(request.url?.path, "/api/chat/start")
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            }

            let didStart = await viewModel.sendMessage("Summarize")
            XCTAssertTrue(didStart)

            let completedSession = try self.makeSessionDetail("""
            {
              "session_id": "session-abc",
              "title": "Planning",
              "messages": [
                {
                  "role": "user",
                  "content": "Summarize",
                  "message_id": "user-1"
                },
                {
                  "role": "assistant",
                  "content": "Done.",
                  "message_id": "assistant-1"
                }
              ]
            }
            """)

            streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

            XCTAssertNil(viewModel.activeStreamID)
            XCTAssertEqual(viewModel.responseCompletionHapticTrigger, 1)
            XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
            XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Summarize", "Done."])
        }
    }

    func testDoneWithoutCompletedSessionRequiresFollowUpTranscriptRefresh() {
        runMainActorTest {
            let streamClient = SpySSEStreamingClient()
            let viewModel = try self.makeViewModel(streamClient: streamClient) { request in
                XCTAssertEqual(request.url?.path, "/api/chat/start")
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            }

            let didStart = await viewModel.sendMessage("Summarize")
            XCTAssertTrue(didStart)

            streamClient.emit(.token("Done."))
            streamClient.emit(.done(DoneStreamEvent(session: nil)))

            XCTAssertNil(viewModel.activeStreamID)
            XCTAssertEqual(viewModel.responseCompletionHapticTrigger, 1)
            XCTAssertTrue(viewModel.responseCompletionNeedsTranscriptRefresh)
            XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Summarize", "Done."])
        }
    }

    @MainActor
    func testCompletedStreamSessionKeepsActivityFromMessageToolCalls() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Check the workspace")
        XCTAssertTrue(didStart)
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "terminal",
            preview: "pwd",
            args: ["command": .string("pwd")],
            duration: nil,
            isError: nil
        )))

        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {
              "role": "user",
              "content": "Check the workspace",
              "message_id": "user-1"
            },
            {
              "role": "assistant",
              "content": "",
              "message_id": "assistant-tool",
              "tool_calls": [
                {
                  "id": "call-1",
                  "function": {
                    "name": "terminal",
                    "arguments": "{\\"command\\":\\"pwd\\"}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "content": "/Users/uzair/project",
              "message_id": "tool-1",
              "tool_call_id": "call-1"
            },
            {
              "role": "assistant",
              "content": "The workspace is /Users/uzair/project.",
              "message_id": "assistant-final"
            }
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertTrue(viewModel.liveToolCalls.isEmpty)
        XCTAssertEqual(viewModel.completedToolCallGroups.count, 1)
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.anchorMessageID, "assistant-tool")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.activityTitle, "Activity: 1 tool")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.name, "terminal")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.preview, "/Users/uzair/project")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.args?["command"], .string("pwd"))
        XCTAssertEqual(
            viewModel.completedToolCallGroupsForAnchor("assistant-tool"),
            viewModel.completedToolCallGroups
        )
        XCTAssertTrue(viewModel.completedToolCallGroupsForAnchor(nil).isEmpty)
    }

    @MainActor
    func testCompletedStreamSessionMergesLiveFallbackIntoCompletedTurnActivity() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Check option 2")
        XCTAssertTrue(didStart)

        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool",
            name: "skill_view",
            preview: "xurl",
            args: ["name": .string("xurl")],
            duration: nil,
            isError: nil,
            stableID: "toolu-skill-xurl"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool_complete",
            name: "skill_view",
            preview: "X/Twitter via xurl CLI",
            args: ["name": .string("xurl")],
            duration: 0.2,
            isError: false,
            stableID: "toolu-skill-xurl"
        )))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool",
            name: "terminal",
            preview: "which xurl",
            args: ["command": .string("which xurl")],
            duration: nil,
            isError: nil,
            stableID: "toolu-terminal-xurl"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool_complete",
            name: "terminal",
            preview: "xurl not installed",
            args: ["command": .string("which xurl")],
            duration: 0.4,
            isError: false,
            stableID: "toolu-terminal-xurl"
        )))

        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {
              "role": "user",
              "content": "Check option 2",
              "message_id": "user-option"
            },
            {
              "role": "assistant",
              "message_id": "assistant-skills",
              "content": [
                {
                  "type": "tool_use",
                  "id": "toolu-skill-xurl",
                  "name": "skill_view",
                  "input": { "name": "xurl" }
                }
              ]
            },
            {
              "role": "assistant",
              "content": "xurl is not installed.",
              "message_id": "assistant-final"
            }
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertTrue(viewModel.liveToolCalls.isEmpty)
        XCTAssertEqual(viewModel.completedToolCallGroups.count, 1)
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.anchorMessageID, "assistant-skills")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.activityTitle, "Activity: 2 tools")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.map(\.name), ["skill_view", "terminal"])
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.id, "toolu-skill-xurl")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.preview, "X/Twitter via xurl CLI")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.last?.preview, "xurl not installed")
        XCTAssertEqual(
            viewModel.completedToolCallGroupsForAnchor("assistant-skills"),
            viewModel.completedToolCallGroups
        )
    }

    @MainActor
    func testCompletedStreamSessionDeduplicatesLiveToolsWithCompletedTranscriptTools() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("I am testing tool use. Use terminal and search files.")
        XCTAssertTrue(didStart)

        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool",
            name: "terminal",
            preview: "pwd",
            args: nil,
            duration: nil,
            isError: nil,
            stableID: "call-terminal"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool_complete",
            name: "terminal",
            preview: "/tmp/workspace",
            args: nil,
            duration: 0.2,
            isError: false,
            stableID: "call-terminal"
        )))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool",
            name: "search_files",
            preview: "README",
            args: nil,
            duration: nil,
            isError: nil,
            stableID: "call-search"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool_complete",
            name: "search_files",
            preview: "README.md",
            args: nil,
            duration: 0.4,
            isError: false,
            stableID: "call-search"
        )))

        XCTAssertEqual(viewModel.liveToolCalls.map(\.name), ["terminal", "search_files"])

        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {
              "role": "user",
              "content": "I am testing tool use. Use terminal and search files.",
              "message_id": "user-tools"
            },
            {
              "role": "assistant",
              "content": "",
              "message_id": "assistant-tools",
              "tool_calls": [
                {
                  "id": "call-terminal",
                  "function": {
                    "name": "terminal",
                    "arguments": "{\\"command\\":\\"pwd\\"}"
                  }
                },
                {
                  "id": "call-search",
                  "function": {
                    "name": "search_files",
                    "arguments": "{\\"pattern\\":\\"README\\"}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "content": "/tmp/workspace",
              "message_id": "tool-terminal",
              "tool_call_id": "call-terminal"
            },
            {
              "role": "tool",
              "content": "README.md",
              "message_id": "tool-search",
              "tool_call_id": "call-search"
            },
            {
              "role": "assistant",
              "content": "Done.",
              "message_id": "assistant-final"
            }
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertTrue(viewModel.liveToolCalls.isEmpty)
        XCTAssertEqual(viewModel.completedToolCallGroups.count, 1)
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.anchorMessageID, "assistant-tools")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.activityTitle, "Activity: 2 tools")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.map(\.name), ["terminal", "search_files"])
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.map(\.id), ["call-terminal", "call-search"])
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.preview, "/tmp/workspace")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.args?["command"], .string("pwd"))
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.last?.preview, "README.md")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.last?.args?["pattern"], .string("README"))
    }

    @MainActor
    func testLiveAssistantActivityPreservesProseReasoningToolProseOrder() async throws {
        let streamClient = SpySSEStreamingClient()
        let modelContext = try makeContext()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {"session_id":"session-abc","stream_id":"stream-123"}
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Inspect it", modelContext: modelContext)
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Before tool. "))
        streamClient.emit(.reasoning("I should inspect now."))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool",
            name: "read_file",
            preview: nil,
            args: ["path": .string("notes.md")],
            duration: nil,
            isError: nil,
            stableID: "call-1"
        )))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: "tool_complete",
            name: "read_file",
            preview: "contents",
            args: ["path": .string("notes.md")],
            duration: 0.1,
            isError: false,
            stableID: "call-1"
        )))
        streamClient.emit(.token("After tool."))

        XCTAssertEqual(viewModel.liveActivityRows.map(\.kind), ["prose", "reasoning", "tools", "prose"])
        XCTAssertEqual(
            viewModel.liveActivityRows.compactMap(\.text),
            ["Before tool. ", "I should inspect now.", "After tool."]
        )
        XCTAssertEqual(viewModel.liveToolCalls.map(\.id), ["call-1"])
        XCTAssertEqual(viewModel.liveToolCalls.first?.isCompleted, true)
        XCTAssertEqual(viewModel.messages.filter { $0.role == "assistant" }.map(\.content), ["Before tool. After tool."])

        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role":"user","content":"Inspect it","message_id":"user-1"},
            {"role":"assistant","content":"Before tool. After tool.","message_id":"assistant-final"}
          ]
        }
        """)
        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertEqual(
            viewModel.archivedActivityRowsForAnchor("assistant-final").map(\.kind),
            ["prose", "reasoning", "tools", "prose"]
        )

        viewModel.cacheCompletedResponse(modelContext: modelContext)
        let cachedAssistant = try XCTUnwrap(CacheStore.cachedMessages(
            serverURL: URL(string: "https://example.test")!,
            sessionID: "session-abc",
            in: modelContext
        ).first(where: { $0.messageId == "assistant-final" }))
        let restoredTimeline = AssistantActivityTimeline.persisted(
            message: cachedAssistant,
            reasoningGroups: [],
            toolCallGroups: []
        )
        XCTAssertEqual(restoredTimeline.rows.map(\.kind), ["prose", "reasoning", "tools", "prose"])
        XCTAssertEqual(
            restoredTimeline.rows.compactMap(\.text),
            ["Before tool. ", "I should inspect now.", "After tool."]
        )
    }

    func testLiveStreamContentCoalescesRapidTokenUpdates() async throws {
        let streamClient = SpySSEStreamingClient()
        streamClient.automaticallyFlushPendingStreamingContent = false
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Stream a long response")
        XCTAssertTrue(didStart)

        for index in 0..<25 {
            streamClient.emit(.token("chunk-\(index)"))
        }

        try await waitForStreamingContent(
            viewModel,
            toSatisfy: { $0 == (0..<25).map { "chunk-\($0)" }.joined() }
        )
    }

}
