#if DEBUG
import Foundation
import os

/// TAL-1043: the fixture chat as one another Agent client owns. `--ui-test-owner-chat` serves an attached owner holding
/// an input whose outcome is unknown and a queued one; `--ui-test-owner-chat-batch` serves an owner the App cannot
/// reattach. Owner actions settle the input they name, and Retry returns its text as the server's draft.
extension UITestFixtureURLProtocol {
    static let nativeNoticesArgument = "--ui-test-native-notices"
    static let nativeNoticePhase = OSAllocatedUnfairLock(initialState: 0)
    static let nativeNoticeStreams = OSAllocatedUnfairLock<[ObjectIdentifier: UITestFixtureURLProtocol]>(initialState: [:])
    static var servesNativeNotices: Bool { ProcessInfo.processInfo.arguments.contains(nativeNoticesArgument) }

    static func advanceNativeNotices() {
        nativeNoticePhase.withLock { $0 += 1 }
        for stream in nativeNoticeStreams.withLock({ Array($0.values) }) {
            stream.client?.urlProtocol(stream, didLoad: Data("event: session-updated\ndata: {\"session_id\":\"\(sessionID)\"}\n\n".utf8))
        }
    }

    func startNativeNoticeStream(url: URL) {
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        Self.nativeNoticeStreams.withLock { $0[ObjectIdentifier(self)] = self }
        client?.urlProtocol(self, didLoad: Data("event: initial\ndata: {\"session_id\":\"\(Self.sessionID)\"}\n\n".utf8))
        if Self.servesNativeNotices {
            client?.urlProtocol(self, didLoad: Data("event: session-updated\ndata: {\"session_id\":\"\(Self.sessionID)\"}\n\n".utf8))
        }
    }

    static let ownerChatArgument = "--ui-test-owner-chat"
    static let ownerChatBatchArgument = "--ui-test-owner-chat-batch"
    static let ownerUnknownText = "Run the migration against staging"
    static let ownerSettledAdmissions = OSAllocatedUnfairLock<Set<String>>(initialState: [])
    /// The full chat's approval as an owner sends it: only the choices its owner accepts, and no approval bypass.
    static let ownerApprovalArgument = "--ui-test-owner-approval"

    static var ownerApprovalChoices: [String: Any] {
        guard ProcessInfo.processInfo.arguments.contains(ownerApprovalArgument) else { return [:] }
        return ["allowed_choices": ["once", "deny"], "can_enable_yolo": false, "pending_count": 1]
    }

    static var servesOwnerChat: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.contains(ownerChatArgument) || arguments.contains(ownerChatBatchArgument) || servesNativeNotices
    }

    static func ownerSessionResponse() -> Data {
        json(["session": ownerSessionDetail()])
    }

    static func ownerActionResponse(_ request: URLRequest) -> Data {
        let body = requestJSON(request)
        ownerSettledAdmissions.withLock { _ = $0.insert(body["admission_id"] as? String ?? "") }
        var answer: [String: Any] = ["ok": true, "session": ownerSessionDetail()]
        if body["action"] as? String == "retry" { answer["draft"] = ownerUnknownText }
        return json(answer)
    }

    private static func ownerSessionDetail() -> [String: Any] {
        var detail = session(id: sessionID, title: sessionTitle)
        detail["messages"] = [
            ["role": "user", "content": "Refactor the CSV importer to stream rows.", "message_id": "owner-prompt", "_ts": 2_000_000_000],
            ["role": "assistant", "content": "The importer now streams rows, so memory stays flat on large files.", "message_id": "owner-reply", "_ts": 2_000_000_001]
        ]
        detail["read_only"] = true
        detail["read_only_reason"] = "This session is owned by the Agent gateway and is display-only in Talaria."
        detail["owner_attachment"] = ownerAttachment()
        if servesNativeNotices {
            let warning: [String: Any] = ["key": "owner-fixture:config-warning", "level": "warn", "text": "Project plugins were skipped", "expires_at": NSNull()]
            let plugin: [String: Any] = ["key": "owner-fixture:plugin:job", "level": "info", "text": "Plugin finished", "expires_at": NSNull()]
            detail["notices"] = nativeNoticePhase.withLock { $0 == 1 ? [warning, plugin] : [warning] }
        }
        return detail
    }

    /// TAL-1045: `--ui-test-execution-modes` offers both diagnostic modes for a new chat, and
    /// `--ui-test-execution-modes-stopped` lists them unavailable while the gateway is stopped. A chat created in a
    /// mode is an attached owner chat with that frozen `execution_mode`.
    static let executionModesArgument = "--ui-test-execution-modes"
    static let executionModesStoppedArgument = "--ui-test-execution-modes-stopped"

    static var servesExecutionModes: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.contains(executionModesArgument) || arguments.contains(executionModesStoppedArgument)
    }

    static func executionModesResponse() -> Data {
        let stopped = ProcessInfo.processInfo.arguments.contains(executionModesStoppedArgument)
        let diagnostic: (String) -> [String: Any] = { mode in
            ["mode": mode, "available": !stopped, "reason": stopped ? "gateway_stopped" : NSNull(), "can_attach": false]
        }
        return json(["modes": [["mode": "normal", "available": true, "reason": NSNull(), "can_attach": true], diagnostic("ignore_config"), diagnostic("safe")]])
    }

    static func diagnosticSession(_ created: [String: Any], mode: String) -> [String: Any] {
        var detail = created
        detail["execution_mode"] = mode
        detail["message_count"] = 0
        detail["read_only"] = true
        detail["read_only_reason"] = "This session is owned by the Agent gateway and is display-only in Talaria."
        detail["owner_attachment"] = ["state": "attached", "reason": NSNull(), "can_submit": true, "can_interrupt": false, "can_attach": false,
                                      "revision": 1, "execution_generation": 0, "active_admission": NSNull(), "admissions": []]
        return detail
    }

    private static func ownerAttachment() -> [String: Any] {
        if servesNativeNotices {
            return ["state": "attached", "reason": NSNull(), "can_submit": true, "can_interrupt": false, "can_attach": false,
                    "revision": 1, "execution_generation": 0, "active_admission": NSNull(), "admissions": []]
        }
        if ProcessInfo.processInfo.arguments.contains(ownerChatBatchArgument) {
            return ["state": "incompatible", "reason": "native_clarify_batch_unavailable", "can_submit": false, "can_interrupt": false,
                    "can_attach": false, "revision": NSNull(), "execution_generation": NSNull(), "active_admission": NSNull(), "admissions": []]
        }
        let settled = ownerSettledAdmissions.withLock { $0 }
        let admissions: [[String: Any]] = [
            ["admission_id": "owner-unknown", "sequence": 3, "status": "unknown", "outcome": NSNull(), "authority_epoch": 1,
             "execution_generation": 1, "text": ownerUnknownText, "input_id": "owner-unknown-request", "actions": ["retry", "discard"]],
            ["admission_id": "owner-queued", "sequence": 4, "status": "queued", "outcome": NSNull(), "authority_epoch": 1,
             "execution_generation": 1, "text": "Then post the summary in #ops", "input_id": "owner-queued-request", "actions": ["cancel"]]
        ].filter { !settled.contains($0["admission_id"] as? String ?? "") }
        let unknown = admissions.contains { $0["status"] as? String == "unknown" }
        return ["state": "attached", "reason": NSNull(), "can_submit": !unknown, "can_interrupt": false, "can_attach": false,
                "revision": 2, "execution_generation": 1, "active_admission": NSNull(), "admissions": admissions]
    }
}
#endif
