import XCTest
@testable import TalariaKit

/// TAL-1043: a chat another Agent client owns takes input through that owner, from the server's recorded
/// `owner_attachment` fixtures (TAL-1038), and follows the owner's reconnect snapshots.
@MainActor
extension ChatViewModelSendTests {
    final class OwnerRequestLog: @unchecked Sendable {
        var bodies: [String: [[String: Any]]] = [:]
        var sessionReads = 0
    }

    /// One recorded attachment from `contracts/fixtures/gateway-owner.json`, as JSON.
    static func ownerAttachmentJSON(_ key: String) throws -> String {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("gateway-owner")) as? [String: Any])
        return String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(fixture[key])), as: UTF8.self)
    }

    /// An owner chat's session object as the server projects it: still `read_only` for Talaria's own writers.
    static func ownerSessionObject(
        attachment: String,
        activeStreamID: String? = nil,
        messages: String = #"[{"role":"user","content":"Started in the CLI","message_id":"cli-1"}]"#
    ) -> String {
        let stream = activeStreamID.map { #","active_stream_id":"\#($0)","is_streaming":true"# } ?? ""
        return #"{"session_id":"session-abc","read_only":true,"read_only_reason":"This session is owned by the Agent gateway and is display-only in Talaria.","owner_attachment":\#(attachment),"messages":\#(messages)\#(stream)}"#
    }

    func ownerViewModel(
        _ log: OwnerRequestLog,
        streamClient: SpySSEStreamingClient? = nil,
        session: @escaping () -> String,
        respond: @escaping (String, URLRequest) -> (HTTPURLResponse, Data)? = { _, _ in nil }
    ) throws -> ChatViewModel {
        try makeViewModel(streamClient: streamClient ?? SpySSEStreamingClient()) { request in
            let path = request.url?.path ?? ""
            if let data = apiTestBodyData(from: request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                log.bodies[path, default: []].append(body)
            }
            if let answer = respond(path, request) { return answer }
            switch path {
            case "/api/session":
                log.sessionReads += 1
                return apiTestJSONResponse(#"{"session":\#(session())}"#, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(#"{"active":true,"stream_id":"owner-stream","replay_available":true}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
    }

    func testAnAttachedOwnerChatSendsThroughItsOwnerWithASubmissionIdentity() async throws {
        let log = OwnerRequestLog()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: normal) }) { path, request in
            guard path == "/api/chat/start" else { return nil }
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"owner-stream","admission_id":"admission-1","owner_attachment":\#(normal)}"#, for: request)
        }
        await viewModel.loadMessages()

        let started = await viewModel.sendMessage("Continue from the phone")

        XCTAssertTrue(started, "An attached owner takes input although the session stays read-only for Talaria's own writers")
        let body = try XCTUnwrap(log.bodies["/api/chat/start"]?.last, "The input goes to the server's owner admission")
        XCTAssertEqual(body["message"] as? String, "Continue from the phone")
        XCTAssertFalse((body["submission_id"] as? String ?? "").isEmpty, "Each owner admission carries its own stable identity")
        XCTAssertEqual(viewModel.activeStreamID, "owner-stream")
    }

    func testTypingDuringAnOwnerRunAdmitsTheInputThroughTheOwnerInsteadOfSteering() async throws {
        let log = OwnerRequestLog()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream") }) { path, request in
            guard path == "/api/chat/start" else { return nil }
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"owner-stream","admission_id":"admission-2"}"#, for: request)
        }
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()
        XCTAssertEqual(viewModel.activeStreamID, "owner-stream", "Opening a running owner chat joins its run")

        let result = await viewModel.submitStreamingMessage("Also check the logs", behavior: .steer)

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertNil(log.bodies["/api/chat/steer"], "The owner orders its own inputs; the App never steers its run")
        let body = try XCTUnwrap(log.bodies["/api/chat/start"]?.last, "The input is admitted by the owner instead")
        XCTAssertEqual(body["message"] as? String, "Also check the logs")
        XCTAssertFalse((body["submission_id"] as? String ?? "").isEmpty)
        XCTAssertEqual(viewModel.activeStreamID, "owner-stream", "The running owner turn keeps its stream")
    }

    func testAnOwnerSnapshotReplacesTheLiveTextAfterAReconnect() async throws {
        let log = OwnerRequestLog()
        let stream = SpySSEStreamingClient()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, streamClient: stream, session: { Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream") })
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()
        stream.emit(.token("Partial text the owner later replaced"))
        XCTAssertEqual(viewModel.messages.last?.content, "Partial text the owner later replaced")

        let persisted = #"[{"role":"user","content":"Started in the CLI","message_id":"cli-1"},{"role":"assistant","content":"Persisted answer so far","message_id":"cli-2"}]"#
        stream.emit(SSEEventDecoder.decode(
            eventType: "session_snapshot",
            data: #"{"session":\#(Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream", messages: persisted)),"replay_gap":false}"#
        ))

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Started in the CLI", "Persisted answer so far"], "The owner's snapshot replaces the live text")
        stream.emit(.token("Next words"))
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Started in the CLI", "Persisted answer so far", "Next words"], "Later output starts a fresh reply row")
    }
}
