import XCTest
import Observation
@testable import TalariaKit

final class ClarificationTests: APIClientTestCase {
    func testServerStepsOnlyFramesRenderEveryStep() throws {
        let payload = #"{"steps":[{"qid":"branch","question":"Which branch?","choices":["main","dev"],"multi_select":false},{"qid":"checks","question":"Which checks?","choices":["unit","ui"],"multi_select":true}]}"#
        for eventType in ["initial", "clarify"] {
            guard case .clarificationPending(let update) = SSEEventDecoder.decode(eventType: eventType, data: payload) else {
                XCTFail("Steps-only \(eventType) must be a clarification")
                continue
            }
            var prompt = ClarificationPromptState(sessionID: "session-abc", pending: try XCTUnwrap(update.pending), pendingCount: 1)
            XCTAssertEqual(prompt.questionCount, 2)
            XCTAssertEqual(prompt.questionID, "branch")
            XCTAssertEqual(prompt.question, "Which branch?")
            XCTAssertEqual(prompt.choices, ["main", "dev"])
            XCTAssertFalse(prompt.isMultiSelect)
            prompt.questionIndex = 1
            XCTAssertEqual(prompt.questionID, "checks")
            XCTAssertEqual(prompt.question, "Which checks?")
            XCTAssertEqual(prompt.choices, ["unit", "ui"])
            XCTAssertTrue(prompt.isMultiSelect)
        }
    }

    @MainActor
    func testServerStepsSubmitKeyedAnswersForSingleMultiSelectAndBatch() async throws {
        for isBatch in [false, true] {
            var received: [String: JSONValue]?
            let model = try makeViewModel { request in
                switch request.url?.path {
                case "/api/chat/start":
                    return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
                case "/api/clarify/respond":
                    let body = try XCTUnwrap(apiTestJSONBody(from: request))
                    XCTAssertEqual(body["session_id"] as? String, "session-abc")
                    XCTAssertEqual(body["clarify_id"] as? String, "server-steps")
                    received = try submittedAnswers(body)
                    return apiTestJSONResponse(#"{"ok":true}"#, for: request)
                case "/api/clarify/pending":
                    return apiTestJSONResponse(#"{"pending":null}"#, for: request)
                default:
                    throw URLError(.badURL)
                }
            }
            _ = await model.sendMessage("Continue")
            let first = isBatch ? #"{"qid":"branch","question":"Branch?","choices":[],"multi_select":false},"# : ""
            let payload = #"{"pending":{"clarify_id":"server-steps","question":"Legacy text","choices_offered":["wrong"],"steps":["# + first + #"{"qid":"checks","question":"Checks?","choices":["unit","ui"],"multi_select":true}]}}"#
            let update = try JSONDecoder().decode(ClarificationPendingResponse.self, from: Data(payload.utf8))
            model.applyClarificationUpdate(update, sessionID: "session-abc")
            if isBatch {
                let advanced = await model.respondToClarification("main")
                XCTAssertTrue(advanced)
                XCTAssertNil(received, "Paging must not submit early")
            }
            let prompt = try XCTUnwrap(model.clarificationPrompt)
            XCTAssertEqual(prompt.question, "Checks?")
            XCTAssertTrue(prompt.isMultiSelect)
            model.toggleClarificationChoice("unit", promptID: prompt.id)
            model.toggleClarificationChoice("ui", promptID: prompt.id)
            XCTAssertEqual(model.clarificationSelectedChoices, ["unit", "ui"])
            let submitted = await model.submitClarificationDraft(promptID: prompt.id)
            XCTAssertTrue(submitted)
            var expected: [String: JSONValue] = ["checks": .array([.string("unit"), .string("ui")])]
            if isBatch { expected["branch"] = .string("main") }
            XCTAssertEqual(received, expected)
            XCTAssertNil(model.clarificationPrompt)
        }
    }

    @MainActor
    func testPendingWithoutStepsRendersNoAnswerablePrompt() async throws {
        let model = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            default:
                XCTFail("A pending clarification without steps must not be answered: \(request.url!.path)")
                throw URLError(.badURL)
            }
        }
        _ = await model.sendMessage("Continue")
        let payload = #"{"pending":{"clarify_id":"legacy","question":"Which branch?","choices_offered":["main"],"questions":[{"qid":"q0","question":"Which branch?","choices":["main"]}]},"pending_count":1}"#
        guard case .clarificationPending(let update) = SSEEventDecoder.decode(eventType: "clarify", data: payload) else {
            return XCTFail("A legacy clarify frame still decodes as a clarification")
        }
        model.applyClarificationUpdate(update, sessionID: "session-abc")
        XCTAssertNil(model.clarificationPrompt)
        let responded = await model.respondToClarification("main")
        XCTAssertFalse(responded)
    }

    func testClarificationPendingDecodesUpstreamShapeTolerantly() throws {
        let response = try JSONDecoder().decode(
            ClarificationPendingResponse.self,
            from: Data("""
            {
              "pending": {
                "clarify_id": "clarify-1",
                "question": "Which branch should I use?",
                "steps": [{"qid": "q0", "question": "Which branch should I use?", "choices": ["main", "dev"], "multi_select": false}],
                "session_id": "session-abc",
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
        XCTAssertEqual(response.pending?.steps?.map(\.choices), [["main", "dev"]])
        XCTAssertEqual(response.pending?.sessionId, "session-abc")
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
            from: Data(#"{"pending":{"steps":[{"qid":"q0","question":"Answer this.","choices":[],"multi_select":false}]}}"#.utf8)
        )
        let prompt = ClarificationPromptState(sessionID: "session-abc", pending: try XCTUnwrap(minimal.pending), pendingCount: 1)
        XCTAssertNil(minimal.pending?.clarifyId)
        XCTAssertNil(minimal.pending?.timeoutSeconds)
        XCTAssertEqual(prompt.question, "Answer this.")
        XCTAssertEqual(prompt.choices, [])
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
                    "steps": [{"qid": "pick", "question": "Pick one", "choices": ["A", "B"], "multi_select": false}],
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
        XCTAssertEqual(pending.pending?.steps?.map(\.choices), [["A", "B"]])

        let response = try await client.respondClarification(
            sessionID: "session-abc",
            clarifyID: "clarify-1",
            answers: ["pick": .string("A")]
        )

        XCTAssertEqual(respondBody?["session_id"] as? String, "session-abc")
        XCTAssertEqual(try submittedAnswers(try XCTUnwrap(respondBody)), ["pick": .string("A")])
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
                sessionId: "session-abc",
                steps: [clarifyStep("Which branch?")]
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
                "steps": [{"qid": "q0", "question": "Choose deployment target", "choices": ["iPhone", "iPad"], "multi_select": false}],
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
        XCTAssertEqual(clarifyResponse.pending?.steps?.map(\.choices), [["iPhone", "iPad"]])
        XCTAssertEqual(clarifyResponse.pendingCount, 1)

        let initial = SSEEventDecoder.decode(
            eventType: "initial",
            data: """
            {
              "pending": {
                "steps": [{"qid": "q0", "question": "What should I do next?", "choices": ["Run tests", "Stop"], "multi_select": false}]
              },
              "pending_count": 1
            }
            """
        )

        guard case .clarificationPending(let initialResponse) = initial else {
            XCTFail("Expected clarificationPending initial event, got \(initial)")
            return
        }

        XCTAssertEqual(initialResponse.pending?.steps?.map(\.question), ["What should I do next?"])
        XCTAssertEqual(initialResponse.pending?.steps?.map(\.choices), [["Run tests", "Stop"]])
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
                sessionId: "session-abc",
                requestedAt: 1_716_150_000,
                timeoutSeconds: 120,
                expiresAt: 1_716_150_120,
                steps: [clarifyStep("Which branch?", choices: ["main", "release"])]
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
        XCTAssertEqual(try submittedAnswers(try XCTUnwrap(respondBody)), ["q0": .string("Use main")])
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
                sessionId: "session-abc",
                steps: [clarifyStep("Which branch?")]
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
                    sessionId: "other-session",
                    steps: [clarifyStep("Other session?")]
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
                    sessionId: "session-abc",
                    steps: [clarifyStep("Current session?")]
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
            pending: PendingClarification(clarifyId: "first", sessionId: "session-abc", steps: [clarifyStep("First?")]),
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
            pending: PendingClarification(clarifyId: "second", sessionId: "session-abc", steps: [clarifyStep("Second?")]),
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
            pending: PendingClarification(clarifyId: "choice", sessionId: "session-abc", steps: [clarifyStep("Pick?", choices: ["A", "B"])]),
            pendingCount: 1
        ), sessionID: "session-abc")
        let promptID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        viewModel.setClarificationDraftResponse("Unsent typed answer", promptID: promptID)
        let didRespond = await viewModel.respondToClarification("B")
        XCTAssertTrue(didRespond)
        XCTAssertEqual(try submittedAnswers(try XCTUnwrap(responseBody)), ["q0": .string("B")])
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
            pending: PendingClarification(clarifyId: "old", sessionId: "session-abc", steps: [clarifyStep("Old?")]), pendingCount: 1
        ), sessionID: "session-abc")
        let oldID = try XCTUnwrap(coordinator.clarificationPrompt?.id)
        coordinator.setClarificationDraftResponse("Old answer", promptID: oldID)
        let submit = Task { await coordinator.submitClarificationDraft(promptID: oldID) }
        await fulfillment(of: [requested], timeout: 5)
        let duplicate = await coordinator.submitClarificationDraft(promptID: oldID)
        XCTAssertFalse(duplicate)
        coordinator.applyClarificationUpdate(ClarificationPendingResponse(
            pending: PendingClarification(clarifyId: "new", sessionId: "session-abc", steps: [clarifyStep("New?")]), pendingCount: 1
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

    func testStepsOnlyInitialEventRendersQuestionAndChoices() throws {
        let event = SSEEventDecoder.decode(eventType: "initial", data: #"{"pending":{"clarify_id":"batch","steps":[{"qid":"q0","question":"What sounds best for a quiet evening?","choices":["A movie","A book","A game","Some music"],"multi_select":false}]},"pending_count":1}"#)
        guard case .clarificationPending(let update) = event else {
            return XCTFail("A steps-only initial payload must be a clarification, not an approval")
        }
        let pending = try XCTUnwrap(update.pending)
        let prompt = ClarificationPromptState(sessionID: "session-abc", pending: pending, pendingCount: 1)
        XCTAssertEqual(prompt.question, "What sounds best for a quiet evening?")
        XCTAssertEqual(prompt.choices, ["A movie", "A book", "A game", "Some music"])
        XCTAssertEqual(prompt.questionID, "q0")
        XCTAssertTrue(prompt.isLastQuestion)
    }

    @MainActor
    func testTypedAnswerSubmitsKeyedAnswers() async throws {
        var receivedAnswers: [String: JSONValue]?
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/clarify/respond":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["clarify_id"] as? String, "batch")
                receivedAnswers = try submittedAnswers(body)
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/clarify/pending":
                return apiTestJSONResponse(#"{"pending":null}"#, for: request)
            default:
                XCTFail("Unexpected route: \(request.url!.path)")
                throw URLError(.badURL)
            }
        }
        _ = await viewModel.sendMessage("Continue")
        let update = try JSONDecoder().decode(ClarificationPendingResponse.self, from: Data(#"{"pending":{"clarify_id":"batch","steps":[{"qid":"q0","question":"Evening?","choices":["A movie","A book"],"multi_select":false}]}}"#.utf8))
        viewModel.applyClarificationUpdate(update, sessionID: "session-abc")
        let id = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        viewModel.setClarificationDraftResponse("A movie", promptID: id)
        let submitted = await viewModel.submitClarificationDraft(promptID: id)
        XCTAssertTrue(submitted)
        XCTAssertEqual(receivedAnswers, ["q0": .string("A movie")])
        XCTAssertNil(viewModel.clarificationPrompt)
    }

    @MainActor
    func testBatchAdvancesLocallyAndRetainsEarlierAndMultiSelectAnswersForRetry() async throws {
        var attempts = 0
        var receivedAnswers: [String: JSONValue]?
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/clarify/respond":
                attempts += 1
                receivedAnswers = try submittedAnswers(try XCTUnwrap(apiTestJSONBody(from: request)))
                if attempts == 1 { throw URLError(.timedOut) }
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/clarify/pending":
                return apiTestJSONResponse(#"{"pending":null}"#, for: request)
            default:
                XCTFail("Unexpected route: \(request.url!.path)")
                throw URLError(.badURL)
            }
        }
        _ = await viewModel.sendMessage("Continue")
        let update = try JSONDecoder().decode(ClarificationPendingResponse.self, from: Data(#"{"pending":{"clarify_id":"batch","steps":[{"qid":"q0","question":"First?","choices":["A","B"],"multi_select":false},{"qid":"q1","question":"Second?","choices":["C","D"],"multi_select":true}]},"pending_count":1}"#.utf8))
        viewModel.applyClarificationUpdate(update, sessionID: "session-abc")
        let firstID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        let advanced = await viewModel.respondToClarification("B")
        XCTAssertTrue(advanced)
        XCTAssertEqual(attempts, 0, "Do not resolve the server prompt before every question is answered")
        XCTAssertEqual(viewModel.clarificationPrompt?.question, "Second?")
        let secondID = try XCTUnwrap(viewModel.clarificationPrompt?.id)
        XCTAssertNotEqual(firstID, secondID)
        viewModel.setClarificationDraftResponse("late first answer", promptID: firstID)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "")
        viewModel.applyClarificationUpdate(update, sessionID: "session-abc")
        XCTAssertEqual(viewModel.clarificationPrompt?.questionID, "q1", "Refreshing the same batch must retain progress")
        viewModel.toggleClarificationChoice("C", promptID: secondID)
        viewModel.toggleClarificationChoice("D", promptID: secondID)
        viewModel.setClarificationDraftResponse("Other", promptID: secondID)
        let failed = await viewModel.submitClarificationDraft(promptID: secondID)
        XCTAssertFalse(failed)
        XCTAssertEqual(viewModel.clarificationDraftResponse, "Other")
        XCTAssertEqual(viewModel.clarificationSelectedChoices, ["C", "D"])
        XCTAssertEqual(receivedAnswers, ["q0": .string("B"), "q1": .array([.string("C"), .string("D"), .string("Other")])])
        let retried = await viewModel.submitClarificationDraft(promptID: secondID)
        XCTAssertTrue(retried)
        XCTAssertEqual(attempts, 2)
        XCTAssertNil(viewModel.clarificationPrompt)
        XCTAssertEqual(viewModel.clarificationSelectedChoices, [])
    }

    @MainActor
    func testManualPagingPreservesEditsAndCannotSubmitMissingAnswers() async throws {
        var received: [String: JSONValue]?
        let model = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/clarify/respond":
                received = try submittedAnswers(try XCTUnwrap(apiTestJSONBody(from: request)))
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/clarify/pending":
                return apiTestJSONResponse(#"{"pending":null}"#, for: request)
            default:
                throw URLError(.badURL)
            }
        }
        _ = await model.sendMessage("Continue")
        let update = try JSONDecoder().decode(ClarificationPendingResponse.self, from: Data(#"{"pending":{"clarify_id":"pages","steps":[{"qid":"q0","question":"First?","choices":[],"multi_select":false},{"qid":"q1","question":"Second?","choices":[],"multi_select":false}]}}"#.utf8))
        model.applyClarificationUpdate(update, sessionID: "session-abc")
        let first = try XCTUnwrap(model.clarificationPrompt?.id)
        model.setClarificationDraftResponse("First draft", promptID: first)
        model.selectClarificationStep(1, promptID: first)
        let second = try XCTUnwrap(model.clarificationPrompt?.id)
        model.setClarificationDraftResponse("Second draft", promptID: second)
        model.selectClarificationStep(0, promptID: second)
        XCTAssertEqual(model.clarificationDraftResponse, "First draft")
        model.setClarificationDraftResponse("", promptID: first)
        model.selectClarificationStep(1, promptID: first)
        XCTAssertEqual(model.clarificationDraftResponse, "Second draft")
        let incomplete = await model.submitClarificationDraft(promptID: second)
        XCTAssertFalse(incomplete)
        XCTAssertNil(received)
        XCTAssertEqual(model.clarificationPrompt?.questionIndex, 0)
        model.setClarificationDraftResponse("Edited first", promptID: first)
        _ = await model.submitClarificationDraft(promptID: first)
        XCTAssertEqual(model.clarificationDraftResponse, "Second draft")
        let submitted = await model.submitClarificationDraft(promptID: second)
        XCTAssertTrue(submitted)
        XCTAssertEqual(received, ["q0": .string("Edited first"), "q1": .string("Second draft")])
    }

    @MainActor
    func testMissingFirstPromptRecoversWithoutTransportErrorAndIgnoresLateEmptySnapshot() async throws {
        let stream = ClarificationSpySSEStreamingClient()
        let delegate = ClarificationTestDelegate()
        delegate.pendingActionHasRunningClarificationTool = true
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/clarify/pending")
            return apiTestJSONResponse(#"{"pending":{"clarify_id":"first","steps":[{"qid":"q0","question":"Recovered first question?","choices":[],"multi_select":false}]},"pending_count":1}"#, for: request)
        }
        let coordinator = ChatPendingActionCoordinator(client: client,
            approvalStreamClient: ClarificationSpySSEStreamingClient(), clarifyStreamClient: stream,
            pollingIntervals: .standard)
        coordinator.delegate = delegate
        defer { coordinator.stopMonitoring(clearPrompt: true) }
        let appeared = expectation(description: "Canonical pending endpoint recovers the first prompt")
        withObservationTracking {
            _ = coordinator.clarificationPrompt
        } onChange: {
            appeared.fulfill()
        }
        coordinator.startMonitoring()
        await fulfillment(of: [appeared], timeout: 10)
        XCTAssertEqual(coordinator.clarificationPrompt?.question, "Recovered first question?")
        stream.emit(SSEEventDecoder.decode(eventType: "initial", data: #"{"pending":null,"pending_count":0}"#))
        XCTAssertEqual(coordinator.clarificationPrompt?.question, "Recovered first question?")
        XCTAssertEqual(stream.stopCount, 0, "Recovery must keep the healthy event stream connected")
    }

    @MainActor
    func testClarifyStreamTransportErrorFallsBackToPollingThePendingEndpoint() async throws {
        let stream = ClarificationSpySSEStreamingClient()
        let delegate = ClarificationTestDelegate()
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/clarify/pending")
            return apiTestJSONResponse(#"{"pending":{"clarify_id":"polled","steps":[{"qid":"q0","question":"Polled question?","choices":[],"multi_select":false}]},"pending_count":1}"#, for: request)
        }
        let coordinator = ChatPendingActionCoordinator(client: client,
            approvalStreamClient: ClarificationSpySSEStreamingClient(), clarifyStreamClient: stream,
            pollingIntervals: ChatPollingIntervals(
                approvalNanoseconds: 10_000_000,
                clarificationNanoseconds: 10_000_000,
                backgroundNanoseconds: 10_000_000
            ))
        coordinator.delegate = delegate
        defer { coordinator.stopMonitoring(clearPrompt: true) }
        coordinator.startMonitoring()
        let appeared = expectation(description: "Fallback polling renders the pending prompt")
        withObservationTracking {
            _ = coordinator.clarificationPrompt
        } onChange: {
            appeared.fulfill()
        }
        // No clarify tool is running, so only the fallback makes the loop poll.
        stream.emit(.transportError("clarify stream failed"))
        await fulfillment(of: [appeared], timeout: 10)
        XCTAssertEqual(coordinator.clarificationPrompt?.question, "Polled question?")
        XCTAssertEqual(stream.stopCount, 1, "The failed stream stops before polling takes over")
    }

    @MainActor
    func testLatePendingHTTPResultCannotEraseANewerStreamPrompt() async throws {
        let pendingRead = expectation(description: "Post-submit pending read started")
        let release = DispatchSemaphore(value: 0)
        let model = try makeViewModel { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/clarify/respond":
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/clarify/pending":
                pendingRead.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
                return apiTestJSONResponse(#"{"pending":null}"#, for: request)
            default:
                throw URLError(.badURL)
            }
        }
        _ = await model.sendMessage("Continue")
        model.applyClarificationUpdate(.init(pending: PendingClarification(clarifyId: "old", steps: [clarifyStep("Old?")]), pendingCount: 1), sessionID: "session-abc")
        let response = Task { await model.respondToClarification("Old answer") }
        await fulfillment(of: [pendingRead], timeout: 10)
        model.applyClarificationUpdate(.init(pending: PendingClarification(clarifyId: "new", steps: [clarifyStep("New?")]), pendingCount: 1), sessionID: "session-abc")
        release.signal()
        _ = await response.value
        XCTAssertEqual(model.clarificationPrompt?.pending.clarifyId, "new")
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
            clarifyStreamClient: clarifyStreamClient ?? ClarificationSpySSEStreamingClient(),
            liveActivityManager: SpyChatLiveActivityManager()
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

private func clarifyStep(_ question: String, qid: String = "q0", choices: [String] = [], multiSelect: Bool = false) -> ClarificationStep {
    let json: [String: Any] = ["qid": qid, "question": question, "choices": choices, "multi_select": multiSelect]
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(ClarificationStep.self, from: JSONSerialization.data(withJSONObject: json))
}

/// Every submit carries server-keyed `answers` and never a raw `response`.
private func submittedAnswers(_ body: [String: Any]) throws -> [String: JSONValue] {
    XCTAssertNil(body["response"], "The server owns the Agent reply envelope")
    let answers = try XCTUnwrap(body["answers"])
    return try JSONDecoder().decode([String: JSONValue].self, from: JSONSerialization.data(withJSONObject: answers))
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
    var pendingActionHasRunningClarificationTool = false
    var pendingActionIsStreamConnectionSuspended = false
    func pendingActionCoordinatorWillSubmitAction() {}
    func pendingActionCoordinatorDidFailAction(_ error: Error) {}
}
