import XCTest
@testable import Talaria

final class ClarificationTests: APIClientTestCase {
    func testClarificationPendingDecodesUpstreamShapeTolerantly() throws {
        let response = try JSONDecoder().decode(
            ClarificationPendingResponse.self,
            from: Data("""
            {
              "pending": {
                "clarify_id": "clarify-1",
                "question": "Which branch should I use?",
                "choices_offered": ["main", 42, true],
                "session_id": "session-abc",
                "kind": "clarify",
                "requested_at": "1716150000.0",
                "timeout_seconds": "120",
                "expires_at": 1716150120.0,
                "future_field": {"ignored": true}
              },
              "pending_count": "2"
            }
            """.utf8)
        )

        XCTAssertEqual(response.pending?.clarifyId, "clarify-1")
        XCTAssertEqual(response.pending?.question, "Which branch should I use?")
        XCTAssertEqual(response.pending?.choicesOffered, ["main", "42.0", "true"])
        XCTAssertEqual(response.pending?.sessionId, "session-abc")
        XCTAssertEqual(response.pending?.kind, "clarify")
        XCTAssertEqual(response.pending?.requestedAt, 1_716_150_000)
        XCTAssertEqual(response.pending?.timeoutSeconds, 120)
        XCTAssertEqual(response.pending?.expiresAt, 1_716_150_120)
        XCTAssertEqual(response.pendingCount, 2)
    }

    func testClarificationPendingDecodesNullAndMissingOptionals() throws {
        let noPending = try JSONDecoder().decode(
            ClarificationPendingResponse.self,
            from: Data(#"{"pending": null}"#.utf8)
        )
        XCTAssertNil(noPending.pending)
        XCTAssertNil(noPending.pendingCount)

        let minimal = try JSONDecoder().decode(
            ClarificationPendingResponse.self,
            from: Data(#"{"pending":{"question":"Answer this."}}"#.utf8)
        )
        XCTAssertEqual(minimal.pending?.displayQuestion, "Answer this.")
        XCTAssertEqual(minimal.pending?.displayChoices, [])
    }

    func testClarificationAPIUsesVerifiedRoutesAndBodies() async throws {
        var requestCount = 0
        var respondBody: [String: Any]?
        let client = makeClient { request in
            requestCount += 1

            switch requestCount {
            case 1:
                XCTAssertEqual(request.url?.path, "/api/clarify/pending")
                XCTAssertEqual(request.httpMethod, "GET")

                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
                XCTAssertEqual(query["session_id"], "session-abc")

                return apiTestJSONResponse("""
                {
                  "pending": {
                    "clarify_id": "clarify-1",
                    "question": "Pick one",
                    "choices_offered": ["A", "B"],
                    "session_id": "session-abc"
                  }
                }
                """, for: request)
            case 2:
                XCTAssertEqual(request.url?.path, "/api/clarify/respond")
                XCTAssertEqual(request.httpMethod, "POST")
                respondBody = try XCTUnwrap(apiTestJSONBody(from: request))
                return apiTestJSONResponse(#"{"ok": true, "response": "A"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let pending = try await client.clarifyPending(sessionID: "session-abc")
        XCTAssertEqual(pending.pending?.clarifyId, "clarify-1")
        XCTAssertEqual(pending.pending?.displayChoices, ["A", "B"])

        let response = try await client.respondClarification(
            sessionID: "session-abc",
            response: "A",
            clarifyID: "clarify-1"
        )

        XCTAssertEqual(respondBody?["session_id"] as? String, "session-abc")
        XCTAssertEqual(respondBody?["response"] as? String, "A")
        XCTAssertEqual(respondBody?["clarify_id"] as? String, "clarify-1")
        XCTAssertEqual(response.ok, true)
        XCTAssertEqual(response.response, "A")
        XCTAssertEqual(client.clarifyStreamURL(sessionID: "session-abc").path, "/api/clarify/stream")
    }

    func testClarificationRespondResponseDecodesStaleFieldsTolerantly() throws {
        let stale = try JSONDecoder().decode(
            ClarificationRespondResponse.self,
            from: Data(#"{"ok": false, "error": "Clarification prompt expired or not found.", "stale": true}"#.utf8)
        )
        XCTAssertEqual(stale.ok, false)
        XCTAssertEqual(stale.stale, true)
        XCTAssertNil(stale.staleCleared)
        XCTAssertNil(stale.relayed)

        let cleared = try JSONDecoder().decode(
            ClarificationRespondResponse.self,
            from: Data(#"{"ok": true, "response": "A", "stale_cleared": "true", "relayed": 1}"#.utf8)
        )
        XCTAssertEqual(cleared.ok, true)
        XCTAssertEqual(cleared.staleCleared, true)
        XCTAssertEqual(cleared.relayed, true)
        XCTAssertNil(cleared.stale)
    }

    @MainActor
    func testClarificationStale409DismissesPromptWithFriendlyExpiredMessage() async throws {
        let streamClient = ClarificationSpySSEStreamingClient()
        let approvalStreamClient = ClarificationSpySSEStreamingClient()
        let clarifyStreamClient = ClarificationSpySSEStreamingClient()
        var didRefreshPendingAfterStale = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/clarify/respond":
                return apiTestJSONResponse(
                    #"{"ok": false, "error": "Clarification prompt expired or not found. The agent may have already proceeded.", "stale": true}"#,
                    statusCode: 409,
                    for: request
                )
            case "/api/clarify/pending":
                didRefreshPendingAfterStale = true
                return apiTestJSONResponse(#"{"pending": null}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Continue")
        XCTAssertTrue(didStart)
        clarifyStreamClient.emit(.clarificationPending(ClarificationPendingResponse(
            pending: PendingClarification(
                clarifyId: "clarify-1",
                question: "Which branch?",
                sessionId: "session-abc"
            ),
            pendingCount: 1
        )))

        let didRespond = await viewModel.respondToClarification("Use main")

        // Expired prompt: the stale card dismisses with a friendly explanation
        // instead of sticking around behind a generic failure (issue #25).
        XCTAssertFalse(didRespond)
        XCTAssertNil(viewModel.clarificationPrompt)
        XCTAssertNil(viewModel.clarificationErrorMessage)
        XCTAssertEqual(
            viewModel.sendErrorMessage,
            PendingPromptExpiredError(prompt: .clarification).localizedDescription
        )
        XCTAssertTrue(didRefreshPendingAfterStale)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    func testSSEDecoderHandlesClarifyAndInitialEvents() {
        let clarify = SSEEventDecoder.decode(
            eventType: "clarify",
            data: """
            {
              "pending": {
                "clarify_id": "clarify-2",
                "question": "Choose deployment target",
                "choices_offered": ["iPhone", "iPad"],
                "session_id": "session-abc"
              },
              "pending_count": 1
            }
            """
        )

        guard case .clarificationPending(let clarifyResponse) = clarify else {
            XCTFail("Expected clarificationPending, got \(clarify)")
            return
        }

        XCTAssertEqual(clarifyResponse.pending?.clarifyId, "clarify-2")
        XCTAssertEqual(clarifyResponse.pending?.displayChoices, ["iPhone", "iPad"])
        XCTAssertEqual(clarifyResponse.pendingCount, 1)

        let initial = SSEEventDecoder.decode(
            eventType: "initial",
            data: """
            {
              "pending": {
                "question": "What should I do next?",
                "choices_offered": ["Run tests", "Stop"]
              },
              "pending_count": 1
            }
            """
        )

        guard case .clarificationPending(let initialResponse) = initial else {
            XCTFail("Expected clarificationPending initial event, got \(initial)")
            return
        }

        XCTAssertEqual(initialResponse.pending?.displayQuestion, "What should I do next?")
        XCTAssertEqual(initialResponse.pending?.displayChoices, ["Run tests", "Stop"])
    }

    @MainActor
    func testChatViewModelClarificationStreamPublishesPromptAndResponds() async throws {
        let streamClient = ClarificationSpySSEStreamingClient()
        let approvalStreamClient = ClarificationSpySSEStreamingClient()
        let clarifyStreamClient = ClarificationSpySSEStreamingClient()
        var respondBody: [String: Any]?
        var didFetchPendingAfterResponse = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/clarify/respond":
                respondBody = try XCTUnwrap(apiTestJSONBody(from: request))
                return apiTestJSONResponse(#"{"ok": true, "response": "Use main"}"#, for: request)
            case "/api/clarify/pending":
                didFetchPendingAfterResponse = true
                return apiTestJSONResponse(#"{"pending": null}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Continue")

        XCTAssertTrue(didStart)
        XCTAssertEqual(streamClient.startedURLs.first?.path, "/api/chat/stream")
        XCTAssertEqual(approvalStreamClient.startedURLs.first?.path, "/api/approval/stream")
        XCTAssertEqual(clarifyStreamClient.startedURLs.first?.path, "/api/clarify/stream")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(clarifyStreamClient.startedURLs.first), resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "session_id" })?
                .value,
            "session-abc"
        )

        clarifyStreamClient.emit(.clarificationPending(ClarificationPendingResponse(
            pending: PendingClarification(
                clarifyId: "clarify-1",
                question: "Which branch?",
                choicesOffered: ["main", "release"],
                sessionId: "session-abc",
                kind: "clarify",
                requestedAt: 1_716_150_000,
                timeoutSeconds: 120,
                expiresAt: 1_716_150_120
            ),
            pendingCount: 1
        )))

        XCTAssertEqual(viewModel.clarificationPrompt?.sessionID, "session-abc")
        XCTAssertEqual(viewModel.clarificationPrompt?.pending.clarifyId, "clarify-1")
        XCTAssertEqual(viewModel.clarificationPrompt?.question, "Which branch?")
        XCTAssertEqual(viewModel.clarificationPrompt?.choices, ["main", "release"])

        let promptID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        viewModel.setClarificationDraftResponse("  Use main  ", promptID: promptID)
        let didRespond = await viewModel.submitClarificationDraft(promptID: promptID)
        XCTAssertTrue(didRespond)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "")

        XCTAssertEqual(respondBody?["session_id"] as? String, "session-abc")
        XCTAssertEqual(respondBody?["response"] as? String, "Use main")
        XCTAssertEqual(respondBody?["clarify_id"] as? String, "clarify-1")
        XCTAssertTrue(didFetchPendingAfterResponse)
        XCTAssertNil(viewModel.clarificationPrompt)
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    @MainActor
    func testClarificationResponseFailureKeepsPromptAndPublishesActionError() async throws {
        let streamClient = ClarificationSpySSEStreamingClient()
        let approvalStreamClient = ClarificationSpySSEStreamingClient()
        let clarifyStreamClient = ClarificationSpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/clarify/respond":
                throw URLError(.timedOut)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Continue")
        XCTAssertTrue(didStart)
        clarifyStreamClient.emit(.clarificationPending(ClarificationPendingResponse(
            pending: PendingClarification(
                clarifyId: "clarify-1",
                question: "Which branch?",
                sessionId: "session-abc"
            ),
            pendingCount: 1
        )))

        let promptID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        viewModel.setClarificationDraftResponse("Use main", promptID: promptID)
        let didRespond = await viewModel.submitClarificationDraft(promptID: promptID)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "Use main")

        XCTAssertFalse(didRespond)
        XCTAssertEqual(viewModel.clarificationPrompt?.pending.clarifyId, "clarify-1")
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertEqual(viewModel.clarificationErrorMessage, viewModel.sendErrorMessage)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    @MainActor
    func testClarificationForDifferentSessionDoesNotRenderOverCurrentChat() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
        }

        let didStart = await viewModel.sendMessage("Continue")
        XCTAssertTrue(didStart)

        viewModel.applyClarificationUpdate(
            ClarificationPendingResponse(
                pending: PendingClarification(
                    clarifyId: "other-clarify",
                    question: "Other session?",
                    sessionId: "other-session"
                ),
                pendingCount: 1
            ),
            sessionID: "other-session"
        )

        XCTAssertNil(viewModel.clarificationPrompt)

        viewModel.applyClarificationUpdate(
            ClarificationPendingResponse(
                pending: PendingClarification(
                    clarifyId: "current-clarify",
                    question: "Current session?",
                    sessionId: "session-abc"
                ),
                pendingCount: 1
            ),
            sessionID: "session-abc"
        )

        XCTAssertEqual(viewModel.clarificationPrompt?.pending.clarifyId, "current-clarify")
    }

    @MainActor
    func testClarificationDraftRejectsEmptyAndStaleSendsAndResetsOnReplacement() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
        }
        _ = await viewModel.sendMessage("Continue")
        let first = ClarificationPendingResponse(
            pending: PendingClarification(clarifyId: "first", question: "First?", sessionId: "session-abc"),
            pendingCount: 2
        )
        viewModel.applyClarificationUpdate(first, sessionID: "session-abc")
        let firstID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        viewModel.setClarificationDraftResponse(" \n ", promptID: firstID)
        let emptySent = await viewModel.submitClarificationDraft(promptID: firstID)
        XCTAssertFalse(emptySent)
        viewModel.setClarificationDraftResponse("/interrupt is a literal answer", promptID: firstID)
        viewModel.applyClarificationUpdate(first, sessionID: "session-abc")
        XCTAssertEqual(viewModel.clarificationDraftResponse, "/interrupt is a literal answer")

        viewModel.applyClarificationUpdate(ClarificationPendingResponse(
            pending: PendingClarification(clarifyId: "second", question: "Second?", sessionId: "session-abc"),
            pendingCount: 1
        ), sessionID: "session-abc")
        let secondID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "")
        XCTAssertNil(viewModel.clarificationErrorMessage)
        viewModel.setClarificationDraftResponse("late keyboard callback", promptID: firstID)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "")
        let staleSent = await viewModel.submitClarificationDraft(promptID: firstID)
        XCTAssertFalse(staleSent)
        viewModel.setClarificationDraftResponse("Second answer", promptID: secondID)
        viewModel.applyClarificationUpdate(ClarificationPendingResponse(pending: nil, pendingCount: 0), sessionID: "session-abc")
        XCTAssertEqual(viewModel.clarificationDraftResponse, "")
        XCTAssertNil(viewModel.clarificationPrompt)
    }

    @MainActor
    func testClarificationChoicePreservesAttachmentsAndClearsTemporaryAnswer() async throws {
        var responseBody: [String: Any]?
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/upload":
                return apiTestJSONResponse(#"{"filename":"draft.txt","path":"/fixture/draft.txt","size":5,"mime":"text/plain","is_image":false}"#, for: request)
            case "/api/clarify/respond":
                responseBody = try XCTUnwrap(apiTestJSONBody(from: request))
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/clarify/pending":
                return apiTestJSONResponse(#"{"pending":null}"#, for: request)
            default:
                XCTFail("Clarification must not send, queue, steer, or interrupt: \(request.url!.path)")
                throw URLError(.badURL)
            }
        }
        _ = await viewModel.sendMessage("Continue")
        await viewModel.uploadAttachment(data: Data("draft".utf8), filename: "draft.txt")
        let attachmentIDs = viewModel.pendingAttachments.map(\.id)
        XCTAssertEqual(attachmentIDs.count, 1)
        viewModel.applyClarificationUpdate(ClarificationPendingResponse(
            pending: PendingClarification(clarifyId: "choice", question: "Pick?", choicesOffered: ["A", "B"], sessionId: "session-abc"),
            pendingCount: 1
        ), sessionID: "session-abc")
        let promptID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        viewModel.setClarificationDraftResponse("Unsent typed answer", promptID: promptID)
        let didRespond = await viewModel.respondToClarification("B")
        XCTAssertTrue(didRespond)
        XCTAssertEqual(responseBody?["response"] as? String, "B")
        XCTAssertNil(responseBody?["attachments"])
        XCTAssertEqual(viewModel.pendingAttachments.map(\.id), attachmentIDs)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "")
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    @MainActor
    func testLateClarificationResponseCannotClearReplacementOrSubmitTwice() async throws {
        let requested = expectation(description: "Clarification request started")
        let release = DispatchSemaphore(value: 0)
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/clarify/respond")
            requested.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 10), .success)
            return apiTestJSONResponse(#"{"ok":true}"#, for: request)
        }
        let delegate = ClarificationTestDelegate()
        let coordinator = ChatPendingActionCoordinator(
            client: client,
            approvalStreamClient: ClarificationSpySSEStreamingClient(),
            clarifyStreamClient: ClarificationSpySSEStreamingClient(),
            pollingIntervals: .standard
        )
        coordinator.delegate = delegate
        coordinator.applyClarificationUpdate(ClarificationPendingResponse(
            pending: PendingClarification(clarifyId: "old", question: "Old?", sessionId: "session-abc"), pendingCount: 1
        ), sessionID: "session-abc")
        let oldID = try XCTUnwrap(coordinator.clarificationPrompt?.id)
        coordinator.setClarificationDraftResponse("Old answer", promptID: oldID)
        let submit = Task { await coordinator.submitClarificationDraft(promptID: oldID) }
        await fulfillment(of: [requested], timeout: 5)
        let duplicate = await coordinator.submitClarificationDraft(promptID: oldID)
        XCTAssertFalse(duplicate)
        coordinator.applyClarificationUpdate(ClarificationPendingResponse(
            pending: PendingClarification(clarifyId: "new", question: "New?", sessionId: "session-abc"), pendingCount: 1
        ), sessionID: "session-abc")
        release.signal()
        let submitted = await submit.value
        XCTAssertTrue(submitted)
        XCTAssertEqual(coordinator.clarificationPrompt?.pending.clarifyId, "new")
        XCTAssertEqual(coordinator.clarificationDraftResponse, "")
        let newID = try XCTUnwrap(coordinator.clarificationPrompt?.id)
        coordinator.setClarificationDraftResponse("New answer", promptID: newID)
        delegate.pendingActionSessionID = "other-session"
        coordinator.applyClarificationUpdate(ClarificationPendingResponse(pending: nil, pendingCount: 0), sessionID: "other-session")
        XCTAssertNil(coordinator.clarificationPrompt)
        XCTAssertEqual(coordinator.clarificationDraftResponse, "")
        coordinator.setClarificationDraftResponse("Late answer", promptID: newID)
        XCTAssertEqual(coordinator.clarificationDraftResponse, "")
    }

    @MainActor
    private func makeViewModel(
        streamClient: SSEStreamingClient? = nil,
        approvalStreamClient: SSEStreamingClient? = nil,
        clarifyStreamClient: SSEStreamingClient? = nil,
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) throws -> ChatViewModel {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = makeClient(handler: handler)
        let session = try makeSession()

        return ChatViewModel(
            session: session,
            server: server,
            client: client,
            streamClient: streamClient ?? ClarificationSpySSEStreamingClient(),
            approvalStreamClient: approvalStreamClient ?? ClarificationSpySSEStreamingClient(),
            clarifyStreamClient: clarifyStreamClient ?? ClarificationSpySSEStreamingClient()
        )
    }

    private func makeSession() throws -> SessionSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            SessionSummary.self,
            from: Data("""
            {
              "session_id": "session-abc",
              "title": "Planning",
              "workspace": "/tmp/workspace",
              "model": "gpt-5.4"
            }
            """.utf8)
        )
    }
}

private final class ClarificationSpySSEStreamingClient: SSEStreamingClient {
    private(set) var startedURLs: [URL] = []
    private(set) var stopCount = 0
    private(set) var lastEventID: String?
    private var onEvent: (@MainActor (SSEEvent) -> Void)?

    func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        startedURLs.append(url)
        lastEventID = nil
        self.onEvent = onEvent
    }

    func stop() {
        stopCount += 1
    }

    @MainActor
    func emit(_ event: SSEEvent) {
        onEvent?(event)
    }
}

@MainActor
private final class ClarificationTestDelegate: ChatPendingActionCoordinatorDelegate {
    var pendingActionSessionID: String? = "session-abc"
    var pendingActionHasActiveStream = true
    var pendingActionIsStreamConnectionSuspended = false
    func pendingActionCoordinatorWillSubmitAction() {}
    func pendingActionCoordinatorDidFailAction(_ error: Error) {}
}
