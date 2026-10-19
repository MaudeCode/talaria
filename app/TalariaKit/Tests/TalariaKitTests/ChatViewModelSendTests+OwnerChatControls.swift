import XCTest
@testable import TalariaKit

/// TAL-1043: an owner chat shows the server's capabilities, prompts and pending inputs, and offers only the recovery
/// actions the server allows; nothing resends on its own.
@MainActor
extension ChatViewModelSendTests {
    private static let queuedAttachment = #"{"state":"attached","reason":null,"can_submit":true,"can_interrupt":true,"can_attach":false,"revision":3,"execution_generation":2,"admissions":[{"admission_id":"queued-1","sequence":4,"status":"queued","outcome":null,"authority_epoch":1,"execution_generation":2,"text":"Then summarize","actions":["cancel","pause"]}]}"#

    func testSharedOwnerFixturesDecodeTheServersCapabilities() throws {
        let decoder = APIClient.responseDecoder()
        func attachment(_ key: String) throws -> OwnerAttachment {
            try decoder.decode(OwnerAttachment.self, from: Data(try Self.ownerAttachmentJSON(key).utf8))
        }
        let normal = try attachment("normal")
        XCTAssertTrue(normal.isAttached)
        XCTAssertEqual([normal.canSubmit, normal.canInterrupt, normal.canAttach], [true, false, false])
        XCTAssertTrue(normal.admissions.isEmpty)

        let unknown = try attachment("unknown")
        XCTAssertFalse(unknown.canSubmit, "An input with an unknown outcome blocks new input")
        XCTAssertEqual(unknown.admissions, [OwnerAdmission(admissionId: "unknown-input", status: "unknown", text: "Inspect uncertain work", executionGeneration: 1, actions: [.retry, .discard])])
        XCTAssertTrue(unknown.hasUnknownAdmission)

        XCTAssertEqual(try attachment("batch").reason, "native_clarify_batch_unavailable")
        XCTAssertEqual(try attachment("served").reason, "served_profile_sessions_unavailable")
        XCTAssertFalse(try attachment("served").isAttached)

        let queued = try decoder.decode(OwnerAttachment.self, from: Data(Self.queuedAttachment.utf8))
        XCTAssertEqual(queued.admissions.first?.actions, [.cancel], "An action this build does not know is not offered")
    }

    func testReadOnlyOwnerStatesKeepTheComposerReadOnlyWithTheServersReason() async throws {
        for (key, reason) in [("batch", "native_clarify_batch_unavailable"), ("served", "served_profile_sessions_unavailable")] {
            let attachment = try Self.ownerAttachmentJSON(key)
            let viewModel = try ownerViewModel(OwnerRequestLog(), session: { Self.ownerSessionObject(attachment: attachment) })
            await viewModel.loadMessages()
            XCTAssertTrue(viewModel.isComposerReadOnly, key)
            XCTAssertEqual(viewModel.ownerAttachment?.reason, reason)
            let started = await viewModel.sendMessage("Try anyway")
            XCTAssertFalse(started, "\(key): an owner that is not attached takes no input")
        }

        let normal = try Self.ownerAttachmentJSON("normal")
        let attached = try ownerViewModel(OwnerRequestLog(), session: { Self.ownerSessionObject(attachment: normal) })
        await attached.loadMessages()
        XCTAssertTrue(attached.isSessionReadOnly, "Edit, regenerate and branch stay with the server's read-only flag")
        XCTAssertFalse(attached.isComposerReadOnly)
    }

    func testANormalChatStartsWithoutAnOwnerIdentity() async throws {
        let log = OwnerRequestLog()
        let viewModel = try ownerViewModel(log, session: { #"{"session_id":"session-abc","messages":[]}"# }) { path, request in
            path == "/api/chat/start" ? apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-1"}"#, for: request) : nil
        }
        await viewModel.loadMessages()
        let started = await viewModel.sendMessage("Hello")
        XCTAssertTrue(started)
        XCTAssertNil(viewModel.ownerAttachment)
        let body = try XCTUnwrap(log.bodies["/api/chat/start"]?.last)
        XCTAssertNil(body["submission_id"])
        XCTAssertEqual(body["model"] as? String, "gpt-5.4", "A direct chat keeps sending its own model")
    }

    func testRetryReturnsTheUnknownInputsTextToTheComposerWithoutResendingIt() async throws {
        let log = OwnerRequestLog()
        let unknown = try Self.ownerAttachmentJSON("unknown")
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: unknown) }) { path, request in
            guard path == "/api/chat/owner-action" else { return nil }
            return apiTestJSONResponse(#"{"ok":true,"session":\#(Self.ownerSessionObject(attachment: normal)),"draft":"Inspect uncertain work"}"#, for: request)
        }
        await viewModel.loadMessages()
        let admission = try XCTUnwrap(viewModel.ownerAttachment?.admissions.first)
        XCTAssertEqual(viewModel.ownerAttachment?.canSubmit, false)
        XCTAssertEqual(admission.actions, [.retry, .discard])

        await viewModel.performOwnerAction(.retry, on: admission)

        let body = try XCTUnwrap(log.bodies["/api/chat/owner-action"]?.last)
        XCTAssertEqual(body["session_id"] as? String, "session-abc")
        XCTAssertEqual(body["action"] as? String, "retry")
        XCTAssertEqual(body["admission_id"] as? String, "unknown-input")
        XCTAssertEqual(body["execution_generation"] as? Int, 1, "Retry is fenced to the admission's generation")
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["Inspect uncertain work"], "Retry puts the text back to review")
        XCTAssertNil(log.bodies["/api/chat/start"], "Retry never resends on its own")
        XCTAssertEqual(viewModel.ownerAttachment?.canSubmit, true)
    }

    func testDiscardAndCancelAreDistinctServerActions() async throws {
        let log = OwnerRequestLog()
        let unknown = try Self.ownerAttachmentJSON("unknown")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: unknown) }) { path, request in
            guard path == "/api/chat/owner-action" else { return nil }
            return apiTestJSONResponse(#"{"ok":true,"session":\#(Self.ownerSessionObject(attachment: Self.queuedAttachment))}"#, for: request)
        }
        await viewModel.loadMessages()
        await viewModel.performOwnerAction(.discard, on: try XCTUnwrap(viewModel.ownerAttachment?.admissions.first))
        let discard = try XCTUnwrap(log.bodies["/api/chat/owner-action"]?.last)
        XCTAssertEqual(discard["action"] as? String, "discard")
        XCTAssertEqual(discard["execution_generation"] as? Int, 1)
        XCTAssertTrue(viewModel.takeReturnedComposerTexts().isEmpty, "Discard returns nothing to the composer")

        let queued = try XCTUnwrap(viewModel.ownerAttachment?.admissions.first)
        XCTAssertEqual(queued.status, "queued", "The server's answer replaced the shown inputs")
        await viewModel.performOwnerAction(.retry, on: queued)
        XCTAssertEqual(log.bodies["/api/chat/owner-action"]?.count, 1, "An action the server does not offer is never sent")
        await viewModel.performOwnerAction(.cancel, on: queued)
        let cancel = try XCTUnwrap(log.bodies["/api/chat/owner-action"]?.last)
        XCTAssertEqual(cancel["action"] as? String, "cancel")
        XCTAssertEqual(cancel["admission_id"] as? String, "queued-1")
        XCTAssertNil(cancel["execution_generation"])
    }

    func testAStaleControlIsRefusedAndTheOwnersCurrentStateReplacesIt() async throws {
        let log = OwnerRequestLog()
        let unknown = try Self.ownerAttachmentJSON("unknown")
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: log.sessionReads <= 1 ? unknown : normal) }) { path, request in
            guard path == "/api/chat/owner-action" else { return nil }
            return (HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, Data(#"{"error":"The unknown admission is stale"}"#.utf8))
        }
        await viewModel.loadMessages()

        await viewModel.performOwnerAction(.retry, on: try XCTUnwrap(viewModel.ownerAttachment?.admissions.first))

        XCTAssertEqual(log.sessionReads, 2, "A refusal reloads the owner's current state")
        XCTAssertEqual(viewModel.ownerAttachment?.admissions, [], "The stale control is gone")
        XCTAssertTrue(viewModel.sendErrorMessage?.contains("stale") == true, "The refusal says why")
        XCTAssertTrue(viewModel.takeReturnedComposerTexts().isEmpty)
        XCTAssertNil(log.bodies["/api/chat/start"])
    }

    func testAnUncertainOwnerAdmissionIsNeverResent() async throws {
        let log = OwnerRequestLog()
        let normal = try Self.ownerAttachmentJSON("normal")
        let unknown = try Self.ownerAttachmentJSON("unknown")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: log.sessionReads <= 1 ? normal : unknown) }) { path, request in
            guard path == "/api/chat/start" else { return nil }
            let refusal = #"{"error":"The owner did not confirm this admission. Reconcile it before resending.","outcome_unknown":true,"owner_attachment":{"state":"unavailable","reason":"owner_connection_lost","can_submit":false,"can_interrupt":false,"can_attach":false,"revision":null,"execution_generation":null,"admissions":[]}}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, Data(refusal.utf8))
        }
        await viewModel.loadMessages()

        let started = await viewModel.sendMessage("Run the migration")

        XCTAssertFalse(started)
        XCTAssertEqual(log.bodies["/api/chat/start"]?.count, 1, "The App never replays an input whose outcome is unknown")
        XCTAssertEqual(viewModel.ownerAttachment?.admissions.map(\.status), ["unknown"], "The reload shows it for an explicit Retry or Discard")
        XCTAssertNotNil(viewModel.sendErrorMessage)
        XCTAssertNotNil(viewModel.lastError, "The failure stays reportable after the reload")
    }

    func testAQueuedOwnerInputShowsFromTheServersAnswer() async throws {
        let log = OwnerRequestLog()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream") }) { path, request in
            guard path == "/api/chat/start" else { return nil }
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"owner-stream","owner_attachment":\#(Self.queuedAttachment),"session":\#(Self.ownerSessionObject(attachment: Self.queuedAttachment, activeStreamID: "owner-stream"))}"#, for: request)
        }
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        _ = await viewModel.submitStreamingMessage("Then summarize", behavior: .queue)

        XCTAssertEqual(viewModel.ownerAttachment?.admissions.map(\.text), ["Then summarize"])
        XCTAssertTrue(viewModel.queuedMessagePreviews.isEmpty, "The owner's queue replaces the device-local one")
    }

    func testOwnerPromptsShowWithOnlyTheOwnersChoicesAndAReplayGapWarns() async throws {
        let stream = SpySSEStreamingClient()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(OwnerRequestLog(), streamClient: stream, session: { Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream") })
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        stream.emit(SSEEventDecoder.decode(eventType: "approval", data: #"{"approval_id":"prompt-1","command":"rm -rf build","allowed_choices":["once","deny"],"can_enable_yolo":false,"pending_count":1}"#))
        let approval = try XCTUnwrap(viewModel.approvalPrompt?.pending)
        XCTAssertEqual(ApprovalChoice.allCases.filter(approval.allows), [.once, .deny])
        XCTAssertFalse(approval.allowsApprovalBypass)
        let legacy = try XCTUnwrap(ApprovalPendingResponse.streamPayload(from: Data(#"{"approval_id":"a","command":"ls"}"#.utf8)).pending)
        XCTAssertEqual(ApprovalChoice.allCases.filter(legacy.allows), ApprovalChoice.allCases, "A server without the field allows every choice")
        XCTAssertTrue(legacy.allowsApprovalBypass)

        stream.emit(SSEEventDecoder.decode(eventType: "clarify", data: #"{"clarify_id":"prompt-2","steps":[{"qid":"q0","question":"Pick a color","choices":["red","blue"],"multi_select":false}],"pending_count":1}"#))
        XCTAssertNotNil(viewModel.clarificationPrompt, "The owner's clarification is answerable here")
        XCTAssertFalse(viewModel.isComposerReadOnly)

        stream.emit(SSEEventDecoder.decode(eventType: "session_snapshot", data: #"{"session":\#(Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream")),"replay_gap":true}"#))
        XCTAssertEqual(viewModel.streamWarningMessage, "Live history was truncated. The final answer will refresh from the owning Agent.")
    }

    /// The approval stream opens with a snapshot of the server's local queue, which an owner's prompts never enter; that
    /// empty snapshot must not hide the owner approval the chat stream already showed. Later updates still apply.
    func testTheApprovalStreamsEmptySnapshotKeepsAnOwnerApprovalTheChatStreamShowed() async throws {
        let stream = SpySSEStreamingClient()
        let approvals = SpySSEStreamingClient()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(OwnerRequestLog(), streamClient: stream, approvalStreamClient: approvals, session: {
            Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream")
        })
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()
        XCTAssertFalse(approvals.startedURLs.isEmpty, "The run opened the approval stream")

        stream.emit(SSEEventDecoder.decode(eventType: "approval", data: #"{"approval_id":"owner-approval","command":"rm -rf build","allowed_choices":["once","deny"],"can_enable_yolo":false,"pending_count":1}"#))
        approvals.emit(SSEEventDecoder.decode(eventType: "initial", data: #"{"pending":null,"pending_count":0}"#))

        XCTAssertEqual(viewModel.approvalPrompt?.pending.approvalId, "owner-approval", "The late empty snapshot must not hide the owner's approval")
        approvals.emit(SSEEventDecoder.decode(eventType: "approval", data: #"{"pending":null,"pending_count":0}"#))
        XCTAssertNil(viewModel.approvalPrompt, "A later update from the approval stream still applies")
    }

    /// Slash text in an owner chat goes to the owning Agent as typed; no local command runs (no device queue, no setting change).
    func testOwnerChatSlashTextGoesToTheOwnerAsTyped() async throws {
        let log = OwnerRequestLog()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream") })
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()

        for text in ["/queue Then summarize", "/model fixture-model", "/steer Check the logs"] {
            let result = await SlashCommandExecutor.execute(text: text, viewModel: viewModel)
            XCTAssertEqual(result, .sendAsMessage, text)
        }
        XCTAssertTrue(viewModel.queuedMessagePreviews.isEmpty)
        XCTAssertEqual(Set(log.bodies.keys), [], "No local command reached the server")
    }

    /// An owner run can finish while a message is on its way; the owner then admits it on a new stream, which the chat follows.
    func testAnOwnerAdmissionOnANewStreamIsFollowed() async throws {
        let stream = SpySSEStreamingClient()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(OwnerRequestLog(), streamClient: stream, session: {
            Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream")
        }) { path, request in
            guard path == "/api/chat/start" else { return nil }
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"owner-stream-2","owner_attachment":\#(normal)}"#, for: request)
        }
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()
        XCTAssertEqual(viewModel.activeStreamID, "owner-stream")

        _ = await viewModel.submitStreamingMessage("One more thing", behavior: .steer)

        XCTAssertEqual(viewModel.activeStreamID, "owner-stream-2", "The accepted input's run is followed")
        let streamURL = try XCTUnwrap(stream.startedURLs.last)
        XCTAssertTrue(streamURL.absoluteString.contains("stream_id=owner-stream-2"))
    }

    /// A second tap while an owner action is in flight sends nothing; the first answer settles it.
    func testOwnerActionsAreSerialized() async throws {
        let log = OwnerRequestLog()
        let unknown = try Self.ownerAttachmentJSON("unknown")
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: unknown) }) { path, request in
            guard path == "/api/chat/owner-action" else { return nil }
            Thread.sleep(forTimeInterval: 0.2)
            return apiTestJSONResponse(#"{"ok":true,"session":\#(Self.ownerSessionObject(attachment: normal))}"#, for: request)
        }
        await viewModel.loadMessages()
        let admission = try XCTUnwrap(viewModel.ownerAttachment?.admissions.first)

        async let first: Void = viewModel.performOwnerAction(.discard, on: admission)
        async let second: Void = viewModel.performOwnerAction(.discard, on: admission)
        _ = await (first, second)

        XCTAssertEqual(log.bodies["/api/chat/owner-action"]?.count, 1, "The duplicate tap never reaches the server")
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertNil(viewModel.ownerActionAdmissionID, "The action settled")
    }

    /// Owner state from an owner action (or a snapshot or admission) is the last server state, so offline shows it.
    func testOwnerStateFromAnActionPersistsForOfflineDisplay() async throws {
        final class State: @unchecked Sendable { var offline = false }
        let state = State()
        let context = try makeContext()
        let normal = try Self.ownerAttachmentJSON("normal")
        let unknown = try Self.ownerAttachmentJSON("unknown")
        func viewModel() throws -> ChatViewModel {
            try makeViewModel { request in
                if state.offline { throw URLError(.notConnectedToInternet) }
                if request.url?.path == "/api/chat/owner-action" {
                    return apiTestJSONResponse(#"{"ok":true,"session":\#(Self.ownerSessionObject(attachment: normal))}"#, for: request)
                }
                return apiTestJSONResponse(#"{"session":\#(Self.ownerSessionObject(attachment: unknown))}"#, for: request)
            }
        }
        let online = try viewModel()
        await online.loadMessages(modelContext: context)
        await online.performOwnerAction(.discard, on: try XCTUnwrap(online.ownerAttachment?.admissions.first), modelContext: context)
        XCTAssertEqual(online.ownerAttachment?.admissions, [])

        state.offline = true
        let offline = try viewModel()
        await offline.loadMessages(modelContext: context)
        XCTAssertTrue(offline.isViewingCachedData)
        XCTAssertEqual(offline.ownerAttachment?.admissions, [], "Offline shows the owner's last state, not the older load")
        XCTAssertEqual(offline.ownerAttachment?.canSubmit, true)
    }

    func testOwnerStateIsCachedPerServerForOfflineDisplay() async throws {
        final class State: @unchecked Sendable { var offline = false }
        let state = State()
        let context = try makeContext()
        let unknown = try Self.ownerAttachmentJSON("unknown")
        let normal = try Self.ownerAttachmentJSON("normal")
        func viewModel(server: String, attachment: String) throws -> ChatViewModel {
            try makeViewModel(server: try XCTUnwrap(URL(string: server))) { request in
                if state.offline { throw URLError(.notConnectedToInternet) }
                return apiTestJSONResponse(#"{"session":\#(Self.ownerSessionObject(attachment: attachment))}"#, for: request)
            }
        }
        // The same session ID on two servers: each keeps its own owner state.
        let first = try viewModel(server: "https://first.test", attachment: unknown)
        let second = try viewModel(server: "https://second.test", attachment: normal)
        await first.loadMessages(modelContext: context)
        await second.loadMessages(modelContext: context)

        state.offline = true
        let firstOffline = try viewModel(server: "https://first.test", attachment: unknown)
        let secondOffline = try viewModel(server: "https://second.test", attachment: normal)
        await firstOffline.loadMessages(modelContext: context)
        await secondOffline.loadMessages(modelContext: context)

        XCTAssertTrue(firstOffline.isViewingCachedData)
        XCTAssertEqual(firstOffline.ownerAttachment?.admissions.map(\.admissionId), ["unknown-input"])
        XCTAssertEqual(secondOffline.ownerAttachment?.admissions, [])
        XCTAssertEqual(secondOffline.ownerAttachment?.canSubmit, true)
    }
}
