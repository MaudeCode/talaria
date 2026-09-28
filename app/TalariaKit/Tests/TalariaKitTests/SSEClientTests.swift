import LDSwiftEventSource
import XCTest
@testable import TalariaKit

@MainActor
final class SSEClientTests: XCTestCase {
    override func tearDown() {
        DelayedSSEURLProtocol.reset()
        RedirectingMockURLProtocol.reset()
        super.tearDown()
    }

    func testSSEClientDeliversIncrementalEventsBeforeDone() async throws {
        DelayedSSEURLProtocol.configure(chunks: [
            DelayedSSEChunk(
                text: "event: reasoning\ndata: {\"text\":\"Thinking live.\"}\n\n",
                delayNanoseconds: 20_000_000
            ),
            DelayedSSEChunk(
                text: "event: tool\ndata: {\"name\":\"read_file\",\"preview\":\"Reading file\"}\n\n",
                delayNanoseconds: 20_000_000
            ),
            DelayedSSEChunk(
                text: "event: token\ndata: {\"text\":\"First live token.\"}\n\n",
                delayNanoseconds: 20_000_000
            ),
            DelayedSSEChunk(
                text: "event: done\ndata: {\"usage\":{}}\n\n",
                delayNanoseconds: 250_000_000
            ),
            DelayedSSEChunk(
                text: "event: stream_end\ndata: {}\n\n",
                delayNanoseconds: 10_000_000
            )
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DelayedSSEURLProtocol.self]
        let client = SSEClient(urlSessionConfiguration: configuration)
        let liveEvent = expectation(description: "received live event before done")
        let doneEvent = expectation(description: "received done event")
        var didFulfillLiveEvent = false
        var receivedEvents: [SSEEvent] = []

        client.start(url: URL(string: "https://example.test/api/chat/stream?stream_id=stream-123")!) { event in
            receivedEvents.append(event)

            if !didFulfillLiveEvent {
                switch event {
                case .reasoning, .toolStarted, .toolCompleted, .token, .interimAssistant:
                    didFulfillLiveEvent = true
                    liveEvent.fulfill()
                default:
                    break
                }
            }

            if case .done = event {
                doneEvent.fulfill()
            }
        }

        // Generous deadline: CI runners under parallel-clone load have blown a
        // 1s budget on wall-clock chunk delays that finish in ~0.3s locally (#76).
        await fulfillment(of: [liveEvent], timeout: 5)
        XCTAssertFalse(receivedEvents.contains { event in
            if case .done = event { return true }
            return false
        })

        await fulfillment(of: [doneEvent], timeout: 5)
        client.stop()

        XCTAssertEqual(Array(receivedEvents.prefix(3)), [
            .reasoning("Thinking live."),
            .toolStarted(ToolStreamEvent(
                eventType: nil,
                name: "read_file",
                preview: "Reading file",
                args: nil,
                duration: nil,
                isError: nil
            )),
            .token("First live token.")
        ])
        XCTAssertEqual(
            DelayedSSEURLProtocol.capturedRequest()?.value(forHTTPHeaderField: "Accept"),
            "text/event-stream"
        )
        XCTAssertEqual(
            DelayedSSEURLProtocol.capturedRequest()?.value(forHTTPHeaderField: "Accept-Encoding"),
            "identity"
        )
        XCTAssertEqual(
            DelayedSSEURLProtocol.capturedRequest()?.value(forHTTPHeaderField: "Cache-Control"),
            "no-cache, no-transform"
        )
    }

    func testSSEClientForwardsHeartbeatComments() async {
        DelayedSSEURLProtocol.configure(chunks: [
            DelayedSSEChunk(text: ": heartbeat\n\n", delayNanoseconds: 0)
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DelayedSSEURLProtocol.self]
        let client = SSEClient(urlSessionConfiguration: configuration)
        let heartbeat = expectation(description: "received heartbeat comment")

        client.start(url: URL(string: "https://example.test/api/chat/stream?stream_id=stream-123")!) { event in
            if case .heartbeat = event {
                heartbeat.fulfill()
            }
        }

        await fulfillment(of: [heartbeat], timeout: 5)
        client.stop()
    }

    func testStaleConnectionCallbacksCannotReachReplacementConnection() async throws {
        let client = makeHangingClient()
        let url = try XCTUnwrap(URL(string: "https://example.test/api/chat/stream?stream_id=stream-a"))
        var staleEvents: [SSEEvent] = []
        var activeEvents: [SSEEvent] = []

        client.start(url: url) { staleEvents.append($0) }
        let staleHandler = try XCTUnwrap(client.eventHandler)
        client.start(url: url) { activeEvents.append($0) }
        let activeHandler = try XCTUnwrap(client.eventHandler)

        activeHandler.onMessage(
            eventType: "token",
            messageEvent: MessageEvent(data: #"{"text":"first"}"#, lastEventId: "session-b:1")
        )
        activeHandler.onMessage(
            eventType: "token",
            messageEvent: MessageEvent(data: #"{"text":"second"}"#, lastEventId: "session-b:2")
        )
        // Connection A's callbacks land after B has started and delivered.
        staleHandler.onMessage(
            eventType: "token",
            messageEvent: MessageEvent(data: #"{"text":"stale"}"#, lastEventId: "session-a:9")
        )
        staleHandler.onMessage(eventType: "reasoning", messageEvent: MessageEvent(data: #"{"text":"stale"}"#))
        staleHandler.onMessage(eventType: "tool", messageEvent: MessageEvent(data: #"{"name":"stale"}"#))
        staleHandler.onMessage(eventType: "done", messageEvent: MessageEvent(data: "{}"))
        staleHandler.onMessage(eventType: "stream_end", messageEvent: MessageEvent(data: "{}"))
        staleHandler.onMessage(eventType: "cancel", messageEvent: MessageEvent(data: "{}"))
        staleHandler.onComment(comment: "heartbeat")
        staleHandler.onError(error: URLError(.networkConnectionLost))
        await drainMainActor()
        client.stop()

        XCTAssertEqual(staleEvents, [])
        XCTAssertEqual(activeEvents, [.token("first"), .token("second")])
        XCTAssertEqual(client.lastEventID, "session-b:2")
    }

    func testStopSuppressesQueuedCallbacksFromStoppedConnection() async throws {
        let client = makeHangingClient()
        let url = try XCTUnwrap(URL(string: "https://example.test/api/chat/stream?stream_id=stream-a"))
        var events: [SSEEvent] = []

        client.start(url: url) { events.append($0) }
        let handler = try XCTUnwrap(client.eventHandler)
        client.stop()

        handler.onMessage(
            eventType: "done",
            messageEvent: MessageEvent(data: "{}", lastEventId: "session-a:3")
        )
        handler.onComment(comment: "heartbeat")
        handler.onError(error: URLError(.networkConnectionLost))
        await drainMainActor()

        XCTAssertEqual(events, [])
        XCTAssertNil(client.lastEventID)
    }

    func testSSEClientProtectsHeadersOnCrossOriginRedirect() async throws {
        let streamURL = try XCTUnwrap(URL(string: "https://example.test/api/chat/stream"))
        let cookieStorage = ServerCookieStore.shared.storage(for: streamURL)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "example.test", .path: "/", .name: "hermes_session", .value: "secret-cookie"
        ]))
        cookieStorage.setCookie(cookie)
        defer { cookieStorage.deleteCookie(cookie) }
        RedirectingMockURLProtocol.redirect = .init(
            fromPath: "/api/chat/stream",
            to: URL(string: "https://third-party.example/final")!
        )
        RedirectingMockURLProtocol.responseData = Data("event: stream_end\ndata: {}\n\n".utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedirectingMockURLProtocol.self]
        let client = SSEClient(
            urlSessionConfiguration: configuration,
            customHeaderProvider: {
                [
                    CustomHeader(name: "Accept", value: "application/json"),
                    CustomHeader(name: "X-Api-Key", value: "secret"),
                    CustomHeader(name: "X-Talaria-Redirect-Policy", value: "user-value")
                ]
            }
        )
        let received = expectation(description: "received redirected stream")

        client.start(url: streamURL) { event in
            if event == .streamEnd { received.fulfill() }
        }

        await fulfillment(of: [received], timeout: 5)
        client.stop()

        let firstHop = try XCTUnwrap(RedirectingMockURLProtocol.firstHopRequest)
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Api-Key"), "secret")
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Talaria-Redirect-Policy"), "user-value")
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "Cookie"), "hermes_session=secret-cookie")
        XCTAssertFalse(firstHop.hasInternalRedirectPolicyHeader)

        let secondHop = try XCTUnwrap(RedirectingMockURLProtocol.secondHopRequest)
        XCTAssertEqual(secondHop.url?.host, "third-party.example")
        XCTAssertEqual(secondHop.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "X-Api-Key"))
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "X-Talaria-Redirect-Policy"))
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(secondHop.hasInternalRedirectPolicyHeader)
    }

    func testSSEClientKeepsCustomHeaderOnSameOriginRedirect() async throws {
        RedirectingMockURLProtocol.redirect = .init(
            fromPath: "/api/chat/stream",
            to: URL(string: "https://example.test/final")!
        )
        RedirectingMockURLProtocol.responseData = Data("event: stream_end\ndata: {}\n\n".utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedirectingMockURLProtocol.self]
        let client = SSEClient(
            urlSessionConfiguration: configuration,
            customHeaderProvider: { [CustomHeader(name: "X-Api-Key", value: "secret")] }
        )
        let received = expectation(description: "received same-origin redirected stream")

        client.start(url: URL(string: "https://example.test/api/chat/stream")!) { event in
            if event == .streamEnd { received.fulfill() }
        }

        await fulfillment(of: [received], timeout: 5)
        client.stop()

        let firstHop = try XCTUnwrap(RedirectingMockURLProtocol.firstHopRequest)
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Api-Key"), "secret")
        XCTAssertFalse(firstHop.hasInternalRedirectPolicyHeader)
        let secondHop = try XCTUnwrap(RedirectingMockURLProtocol.secondHopRequest)
        XCTAssertEqual(secondHop.value(forHTTPHeaderField: "X-Api-Key"), "secret")
        XCTAssertFalse(secondHop.hasInternalRedirectPolicyHeader)
    }

    func testSSEClientDeinitUnregistersRedirectPolicy() {
        let initialCount = CrossOriginRedirectGuardURLProtocol.registeredPolicyCount
        var client: SSEClient? = SSEClient(urlSessionConfiguration: .ephemeral)
        weak let weakClient = client

        client?.start(url: URL(string: "https://example.test/api/chat/stream")!) { _ in }
        XCTAssertEqual(CrossOriginRedirectGuardURLProtocol.registeredPolicyCount, initialCount + 1)
        client = nil

        XCTAssertNil(weakClient)
        XCTAssertEqual(CrossOriginRedirectGuardURLProtocol.registeredPolicyCount, initialCount)
    }

    func testDecodesToolStartedEventFromUpstreamPayload() {
        let event = SSEEventDecoder.decode(
            eventType: "tool",
            data: """
            {
              "event_type": "tool.started",
              "name": "read_file",
              "kind": "read",
              "target": "/tmp/example.swift",
              "preview": "Reading file",
              "args": {
                "path": "/tmp/example.swift",
                "limit": 120,
                "recursive": false
              }
            }
            """
        )

        guard case .toolStarted(let payload) = event else {
            XCTFail("Expected toolStarted, got \(event)")
            return
        }

        XCTAssertEqual(payload.eventType, "tool.started")
        XCTAssertEqual(payload.name, "read_file")
        XCTAssertEqual(payload.kind, .read)
        XCTAssertEqual(payload.target, "/tmp/example.swift")
        XCTAssertEqual(payload.preview, "Reading file")
        XCTAssertEqual(payload.args?["path"], .string("/tmp/example.swift"))
        XCTAssertEqual(payload.args?["limit"], .number(120))
        XCTAssertEqual(payload.args?["recursive"], .bool(false))
        XCTAssertNil(payload.duration)
        XCTAssertNil(payload.isError)
        XCTAssertNil(payload.stableID)
    }

    func testDecodesToolCompletedEventFromUpstreamPayload() {
        let event = SSEEventDecoder.decode(
            eventType: "tool_complete",
            data: """
            {
              "event_type": "tool.completed",
              "name": "shell",
              "preview": "Done",
              "args": {
                "cmd": "swift test"
              },
              "duration": 1.25,
              "is_error": true
            }
            """
        )

        guard case .toolCompleted(let payload) = event else {
            XCTFail("Expected toolCompleted, got \(event)")
            return
        }

        XCTAssertEqual(payload.eventType, "tool.completed")
        XCTAssertEqual(payload.name, "shell")
        // An older server sends no display fields; the app does not derive them from the name.
        XCTAssertNil(payload.kind)
        XCTAssertNil(payload.target)
        XCTAssertEqual(payload.preview, "Done")
        XCTAssertEqual(payload.args?["cmd"], .string("swift test"))
        XCTAssertEqual(payload.duration, 1.25)
        XCTAssertEqual(payload.isError, true)
        XCTAssertNil(payload.stableID)
    }

    func testDecodesStableToolIDFromServerIDOnly() {
        let event = SSEEventDecoder.decode(
            eventType: "tool",
            data: """
            {
              "id": "  call-123  ",
              "name": "terminal",
              "preview": "Running command"
            }
            """
        )

        guard case .toolStarted(let payload) = event else {
            return XCTFail("Expected toolStarted, got \(event)")
        }

        XCTAssertEqual(payload.stableID, "call-123")
        XCTAssertEqual(payload.name, "terminal")
        XCTAssertEqual(payload.preview, "Running command")

        // The server ships one `id`; other keys are not tool identities.
        for key in ["tid", "tool_call_id", "tool_use_id", "call_id"] {
            let legacy = SSEEventDecoder.decode(
                eventType: "tool_complete",
                data: #"{"\#(key)": "call-123", "name": "terminal"}"#
            )
            guard case .toolCompleted(let payload) = legacy else {
                return XCTFail("Expected toolCompleted for \(key), got \(legacy)")
            }
            XCTAssertNil(payload.stableID, "key \(key)")
        }
    }

    func testDecodesReasoningEventFromUpstreamPayload() {
        let event = SSEEventDecoder.decode(
            eventType: "reasoning",
            data: #"{"text":"I need to inspect the file first."}"#
        )

        XCTAssertEqual(event, .reasoning("I need to inspect the file first."))
    }

    func testDecodesOptionalReasoningTitleSnapshot() {
        let event = SSEEventDecoder.decode(
            eventType: "reasoning",
            data: #"{"text":" reasoning delta","titles":["Planning implementation","Running tests"]}"#
        )

        XCTAssertEqual(event, .reasoning(ReasoningStreamEvent(
            text: " reasoning delta",
            titles: ["Planning implementation", "Running tests"]
        )))
    }

    func testMalformedOptionalReasoningTitlesDoNotDropText() {
        let event = SSEEventDecoder.decode(
            eventType: "reasoning",
            data: #"{"text":"legacy text","titles":{"bad":true}}"#
        )

        XCTAssertEqual(event, .reasoning("legacy text"))
    }

    func testDecodesInterimAssistantEventFromUpstreamPayload() {
        let event = SSEEventDecoder.decode(
            eventType: "interim_assistant",
            data: #"{"text":"Inspecting repo structure.","already_streamed":false}"#
        )

        XCTAssertEqual(
            event,
            .interimAssistant(InterimAssistantStreamEvent(
                text: "Inspecting repo structure.",
                alreadyStreamed: false
            ))
        )
    }

    func testInterimAssistantPayloadToleratesTypeDrift() {
        let event = SSEEventDecoder.decode(
            eventType: "interim_assistant",
            data: #"{"text":42,"already_streamed":"true"}"#
        )

        XCTAssertEqual(
            event,
            .interimAssistant(InterimAssistantStreamEvent(
                text: "42",
                alreadyStreamed: true
            ))
        )
    }

    func testToolPayloadToleratesMissingFields() {
        let event = SSEEventDecoder.decode(eventType: "tool", data: #"{"name":"tool_without_args"}"#)

        guard case .toolStarted(let payload) = event else {
            XCTFail("Expected toolStarted, got \(event)")
            return
        }

        XCTAssertNil(payload.eventType)
        XCTAssertEqual(payload.name, "tool_without_args")
        XCTAssertNil(payload.preview)
        XCTAssertNil(payload.args)
    }

    func testDecodesDoneEventAsStreamCompletionSignal() {
        let event = SSEEventDecoder.decode(
            eventType: "done",
            data: #"{"session":{"session_id":"abc123"},"usage":{}}"#
        )

        guard case .done(let payload) = event else {
            XCTFail("Expected done event.")
            return
        }

        XCTAssertEqual(payload.session?.sessionId, "abc123")
        XCTAssertEqual(payload.usage, ContextWindowSnapshot(
            contextLength: nil,
            thresholdTokens: nil,
            lastPromptTokens: nil,
            inputTokens: nil,
            outputTokens: nil,
            estimatedCost: nil
        ))
    }

    func testDecodesDoneEventUsagePayload() {
        let event = SSEEventDecoder.decode(
            eventType: "done",
            data: """
            {
              "session": {"session_id": "abc123"},
              "usage": {
                "input_tokens": 1200,
                "output_tokens": 300,
                "estimated_cost": 0.0123,
                "context_length": 128000,
                "threshold_tokens": 100000,
                "last_prompt_tokens": 45000
              }
            }
            """
        )

        guard case .done(let payload) = event else {
            XCTFail("Expected done event.")
            return
        }

        XCTAssertEqual(payload.session?.sessionId, "abc123")
        XCTAssertEqual(payload.usage, ContextWindowSnapshot(
            contextLength: 128_000,
            thresholdTokens: 100_000,
            lastPromptTokens: 45_000,
            inputTokens: 1_200,
            outputTokens: 300,
            estimatedCost: 0.0123
        ))
    }

    func testDecodesDisplayableLiveMeteringPayload() {
        let event = SSEEventDecoder.decode(
            eventType: "metering",
            data: """
            {
              "session_id": "abc123",
              "tps": 42.25,
              "tps_available": true,
              "estimated": false,
              "unknown_future_field": "ignored"
            }
            """
        )

        guard case .metering(let payload) = event else {
            XCTFail("Expected metering event.")
            return
        }

        XCTAssertEqual(payload.sessionId, "abc123")
        XCTAssertEqual(payload.displayableTokensPerSecond, 42.25)
    }

    func testDecodesMissingLiveMeteringFieldsAsNil() {
        let event = SSEEventDecoder.decode(eventType: "metering", data: "{}")

        guard case .metering(let payload) = event else {
            XCTFail("Expected metering event.")
            return
        }

        XCTAssertNil(payload.tokensPerSecond)
        XCTAssertNil(payload.isTokensPerSecondAvailable)
        XCTAssertNil(payload.isEstimated)
        XCTAssertNil(payload.sessionId)
    }

    func testMalformedLiveMeteringFieldsDoNotDiscardValidFields() {
        let event = SSEEventDecoder.decode(
            eventType: "metering",
            data: """
            {
              "tps": {"unexpected": true},
              "tps_available": ["unexpected"],
              "estimated": {"unexpected": true},
              "session_id": "abc123"
            }
            """
        )

        guard case .metering(let payload) = event else {
            XCTFail("Expected metering event.")
            return
        }

        XCTAssertNil(payload.tokensPerSecond)
        XCTAssertNil(payload.isTokensPerSecondAvailable)
        XCTAssertNil(payload.isEstimated)
        XCTAssertEqual(payload.sessionId, "abc123")

        let malformedSessionEvent = SSEEventDecoder.decode(
            eventType: "metering",
            data: """
            {
              "tps": 42.5,
              "tps_available": true,
              "estimated": false,
              "session_id": {"unexpected": true}
            }
            """
        )

        guard case .metering(let malformedSessionPayload) = malformedSessionEvent else {
            XCTFail("Expected metering event.")
            return
        }

        XCTAssertEqual(malformedSessionPayload.displayableTokensPerSecond, 42.5)
        XCTAssertNil(malformedSessionPayload.sessionId)
    }

    func testLiveMeteringUsesLossyDecodingForOptionalFields() {
        let event = SSEEventDecoder.decode(
            eventType: "metering",
            data: """
            {
              "tps": "42.5",
              "tps_available": "true",
              "estimated": 0,
              "session_id": 123
            }
            """
        )

        guard case .metering(let payload) = event else {
            XCTFail("Expected metering event.")
            return
        }

        XCTAssertEqual(payload.tokensPerSecond, 42.5)
        XCTAssertEqual(payload.isTokensPerSecondAvailable, true)
        XCTAssertEqual(payload.isEstimated, false)
        XCTAssertEqual(payload.sessionId, "123")
    }

    func testLiveMeteringRequiresAvailableExactPositiveFiniteTps() {
        XCTAssertNil(MeteringStreamEvent(
            tokensPerSecond: 10,
            isTokensPerSecondAvailable: false,
            isEstimated: false,
            sessionId: nil
        ).displayableTokensPerSecond)
        XCTAssertNil(MeteringStreamEvent(
            tokensPerSecond: 10,
            isTokensPerSecondAvailable: true,
            isEstimated: true,
            sessionId: nil
        ).displayableTokensPerSecond)
        XCTAssertNil(MeteringStreamEvent(
            tokensPerSecond: 0,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: nil
        ).displayableTokensPerSecond)
        XCTAssertNil(MeteringStreamEvent(
            tokensPerSecond: .infinity,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: nil
        ).displayableTokensPerSecond)
    }

    func testDoneUsageDecodesFinalTokensPerSecond() {
        let event = SSEEventDecoder.decode(
            eventType: "done",
            data: #"{"usage":{"tps":51.75,"duration_seconds":532}}"#
        )

        guard case .done(let payload) = event else {
            XCTFail("Expected done event.")
            return
        }

        XCTAssertEqual(payload.usage?.tokensPerSecond, 51.75)
        XCTAssertEqual(payload.usage?.durationSeconds, 532)
    }

    func testMalformedDoneUsageTpsDoesNotDiscardOtherUsageFields() {
        let event = SSEEventDecoder.decode(
            eventType: "done",
            data: #"{"usage":{"context_length":"32768","input_tokens":1200,"tps":{"unexpected":true}}}"#
        )

        guard case .done(let payload) = event else {
            XCTFail("Expected done event.")
            return
        }

        XCTAssertEqual(payload.usage?.contextLength, 32_768)
        XCTAssertEqual(payload.usage?.inputTokens, 1_200)
        XCTAssertNil(payload.usage?.tokensPerSecond)
    }

    func testDecodesDoneEventSessionMessages() {
        let event = SSEEventDecoder.decode(
            eventType: "done",
            data: """
            {
              "session": {
                "session_id": "abc123",
                "title": "Approval test",
                "messages": [
                  {
                    "role": "user",
                    "content": "Do it one more time",
                    "message_id": "user-1",
                    "timestamp": 1770000100
                  },
                  {
                    "role": "assistant",
                    "content": "Same result -- approval gate triggered, then completed.",
                    "message_id": "assistant-1",
                    "timestamp": 1770000101
                  }
                ]
              },
              "usage": {}
            }
            """
        )

        guard case .done(let payload) = event else {
            XCTFail("Expected done event.")
            return
        }

        XCTAssertEqual(payload.session?.sessionId, "abc123")
        XCTAssertEqual(payload.session?.title, "Approval test")
        XCTAssertEqual(payload.session?.messages?.compactMap(\.content), [
            "Do it one more time",
            "Same result -- approval gate triggered, then completed."
        ])
    }

    func testDecodesPendingSteerLeftoverEvent() {
        let event = SSEEventDecoder.decode(
            eventType: "pending_steer_leftover",
            data: #"{"session_id":"abc123","text":"follow this constraint"}"#
        )

        XCTAssertEqual(event, .pendingSteerLeftover(SteeringStreamEvent(
            sessionId: "abc123",
            text: "follow this constraint"
        )))
    }

    func testErrorAndCancelFramesDeliverTheirSettledSessionFirst() {
        let failed = SSEEventDecoder.decodeFrame(
            eventType: "apperror",
            data: #"{"type":"error","message":"boom","session":{"session_id":"abc123","messages":[]}}"#
        )
        XCTAssertEqual(failed.count, 2)
        guard case .settledSession(let session) = failed.first else { return XCTFail("Expected the settled session first") }
        XCTAssertEqual(session.sessionId, "abc123")
        XCTAssertEqual(failed.last, .error("boom"))
        XCTAssertEqual(SSEEventDecoder.decodeFrame(eventType: "cancel", data: "{}"), [.cancelled])
        XCTAssertEqual(SSEEventDecoder.decodeFrame(eventType: "token", data: #"{"text":"hi"}"#).count, 1)
    }

    func testDecodesConsumedSteerEvent() {
        let event = SSEEventDecoder.decode(
            eventType: "steer_consumed",
            data: #"{"session_id":"abc123","stream_id":"stream-1","steer_id":"local-steer-1","text":"stop after the next sleep","created_at":10,"consumed_at":12}"#
        )

        XCTAssertEqual(event, .steerConsumed(SteeringStreamEvent(
            sessionId: "abc123",
            streamId: "stream-1",
            steerId: "local-steer-1",
            text: "stop after the next sleep",
            createdAt: 10,
            consumedAt: 12
        )))
    }

    func testDecodesApprovalInitialEventFromApprovalStream() {
        let event = SSEEventDecoder.decode(
            eventType: "initial",
            data: """
            {
              "pending": {
                "approval_id": "approval-1",
                "command": "curl https://example.test/install.sh | bash",
                "description": "High risk command",
                "pattern_keys": ["network_download", "pipe_to_shell"]
              },
              "pending_count": 2
            }
            """
        )

        guard case .approvalPending(let response) = event else {
            XCTFail("Expected approvalPending, got \(event)")
            return
        }

        XCTAssertEqual(response.pending?.approvalId, "approval-1")
        XCTAssertEqual(response.pending?.displayPatternKeys, ["network_download", "pipe_to_shell"])
        XCTAssertEqual(response.pendingCount, 2)
    }

    func testDecodesDirectApprovalEventFromChatStream() {
        let event = SSEEventDecoder.decode(
            eventType: "approval",
            data: """
            {
              "approval_id": "approval-2",
              "command": "python script.py",
              "description": "Run Python",
              "pattern_key": "python_exec"
            }
            """
        )

        guard case .approvalPending(let response) = event else {
            XCTFail("Expected approvalPending, got \(event)")
            return
        }

        XCTAssertEqual(response.pending?.approvalId, "approval-2")
        XCTAssertEqual(response.pending?.displayPatternKeys, ["python_exec"])
        XCTAssertEqual(response.pendingCount, 1)
    }

    func testDecodesTitleEventFromUpstreamPayload() {
        let event = SSEEventDecoder.decode(
            eventType: "title",
            data: #"{"session_id":"abc123","title":"SwiftUI Chat Polish"}"#
        )

        XCTAssertEqual(
            event,
            .title(TitleStreamEvent(sessionId: "abc123", title: "SwiftUI Chat Polish"))
        )
    }

    func testMalformedToolPayloadDoesNotCrashOrSurfaceError() {
        let event = SSEEventDecoder.decode(eventType: "tool_complete", data: "{")

        guard case .toolCompleted(let payload) = event else {
            XCTFail("Expected toolCompleted, got \(event)")
            return
        }

        XCTAssertNil(payload.eventType)
        XCTAssertNil(payload.name)
        XCTAssertNil(payload.preview)
        XCTAssertNil(payload.args)
        XCTAssertNil(payload.duration)
        XCTAssertNil(payload.isError)
        XCTAssertNil(payload.stableID)
    }

    func testMalformedDonePayloadSurfacesTransportError() {
        let event = SSEEventDecoder.decode(eventType: "done", data: "{")

        XCTAssertEqual(event, .transportError("The stream returned a malformed completion event."))
    }

    func testMalformedDoneUsagePayloadSurfacesTransportError() {
        let event = SSEEventDecoder.decode(eventType: "done", data: #"{"usage":"bad"}"#)

        XCTAssertEqual(event, .transportError("The stream returned a malformed completion event."))
    }

    func testMalformedDoneSessionPayloadSurfacesTransportError() {
        let event = SSEEventDecoder.decode(eventType: "done", data: #"{"session":1,"usage":{}}"#)

        XCTAssertEqual(event, .transportError("The stream returned a malformed completion event."))
    }

    func testMalformedErrorPayloadSurfacesExplicitError() {
        let event = SSEEventDecoder.decode(eventType: "error", data: "{")

        XCTAssertEqual(event, .error("The stream returned a malformed error event."))
    }

    func testAppErrorEventDecodesPinnedUpstreamMessageShape() {
        // Pinned upstream `_provider_error_payload`: {message, type, hint, details, session, …}.
        let event = SSEEventDecoder.decode(
            eventType: "apperror",
            data: #"{"message": "Provider exploded", "type": "no_response", "hint": "Check the provider keys.", "details": "Provider exploded", "session_id": "session-abc", "session": {"session_id": "session-abc"}}"#
        )

        XCTAssertEqual(event, .error("Provider exploded"))
    }

    func testAppErrorEventDecodesDocsErrorShape() {
        // API docs describe the payload as {error, type, session, terminal_state?}.
        let event = SSEEventDecoder.decode(
            eventType: "apperror",
            data: #"{"error": "Terminal failure", "type": "tool_limit_reached", "terminal_state": "tool_limit_reached"}"#
        )

        XCTAssertEqual(event, .error("Terminal failure", terminalState: "tool_limit_reached"))
    }

    func testDoneEventDecodesServerTerminalState() {
        let event = SSEEventDecoder.decode(eventType: "done", data: #"{"terminal_state": "no_response"}"#)

        XCTAssertEqual(event, .done(DoneStreamEvent(terminalState: "no_response")))
    }

    func testAppErrorEventWithoutMessageFallsBackToGenericError() {
        let event = SSEEventDecoder.decode(eventType: "apperror", data: "{}")

        XCTAssertEqual(event, .error("The stream returned an error."))
    }

    func testMalformedAppErrorPayloadSurfacesExplicitError() {
        let event = SSEEventDecoder.decode(eventType: "apperror", data: "{")

        XCTAssertEqual(event, .error("The stream returned a malformed error event."))
    }

    func testUnknownStreamEventTypeIsIgnored() {
        let event = SSEEventDecoder.decode(
            eventType: "future_server_event",
            data: #"{"text":"new payload"}"#
        )

        XCTAssertEqual(event, .ignored)
    }

    func testDeallocatedClientDropsQueuedCallbacks() async throws {
        var client: SSEClient? = makeHangingClient()
        let url = try XCTUnwrap(URL(string: "https://example.test/api/chat/stream?stream_id=stream-a"))
        var events: [SSEEvent] = []

        client?.start(url: url) { events.append($0) }
        let handler = try XCTUnwrap(client?.eventHandler)
        client = nil

        handler.onMessage(eventType: "token", messageEvent: MessageEvent(data: #"{"text":"stale"}"#))
        handler.onError(error: URLError(.networkConnectionLost))
        await drainMainActor()

        XCTAssertEqual(events, [])
    }

    /// A client whose transport opens but never emits, so only the handler
    /// calls made by the test reach the callback.
    private func makeHangingClient() -> SSEClient {
        DelayedSSEURLProtocol.configure(chunks: [
            DelayedSSEChunk(text: ": keepalive\n\n", delayNanoseconds: 60_000_000_000)
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DelayedSSEURLProtocol.self]
        return SSEClient(urlSessionConfiguration: configuration)
    }
}

extension URLRequest {
    var hasInternalRedirectPolicyHeader: Bool {
        allHTTPHeaderFields?.keys.contains {
            $0.lowercased().hasPrefix("x-talaria-redirect-policy-")
        } == true
    }
}

private struct DelayedSSEChunk {
    let text: String
    let delayNanoseconds: UInt64
}

private final class DelayedSSEURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var chunks: [DelayedSSEChunk] = []
    private static var lastRequest: URLRequest?

    private var loadingTask: Task<Void, Never>?

    static func configure(chunks: [DelayedSSEChunk]) {
        lock.lock()
        self.chunks = chunks
        lastRequest = nil
        lock.unlock()
    }

    static func reset() {
        lock.lock()
        chunks = []
        lastRequest = nil
        lock.unlock()
    }

    static func capturedRequest() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return lastRequest
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let chunks: [DelayedSSEChunk]
        Self.lock.lock()
        Self.lastRequest = request
        chunks = Self.chunks
        Self.lock.unlock()

        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache"
                ]
              )
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        loadingTask = Task { [weak self] in
            guard let self else { return }
            for chunk in chunks {
                guard !Task.isCancelled else { return }
                if chunk.delayNanoseconds > 0 {
                    try? await Task.sleep(nanoseconds: chunk.delayNanoseconds)
                }
                guard !Task.isCancelled else { return }
                client?.urlProtocol(self, didLoad: Data(chunk.text.utf8))
            }

            guard !Task.isCancelled else { return }
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        loadingTask?.cancel()
    }
}
