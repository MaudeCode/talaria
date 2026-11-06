#if DEBUG
import Foundation
import os

/// TAL-1321: the fixture's connection operation, as the server's view states it: a link waiting on authorization, an
/// install asking for a masked credential, and a failed row. Answers change it only through its own route.
extension UITestFixtureURLProtocol {
    static let connectionOperationPathPrefix = "/api/connectors/operations/"

    struct ConnectionOperationFixtureState {
        var settled = false
        var states = ["gmail": "initiated", "linear": "pending", "notion": "failed"]
        var answers: [[String: String]] = []
        var env: [String: String] = [:]
    }

    static let connectionOperationState = OSAllocatedUnfairLock(initialState: ConnectionOperationFixtureState())

    static var connectionOperationIsSettled: Bool { connectionOperationState.withLock(\.settled) }

    static func resetConnectionOperation() {
        connectionOperationState.withLock { $0 = ConnectionOperationFixtureState() }
    }

    static func connectionOperationResponse(_ request: URLRequest) -> Data {
        if request.httpMethod == "POST" {
            let body = requestJSON(request)
            let action = body["action"] as? String ?? ""
            let target = body["target"] as? String ?? ""
            let env = body["env"] as? [String: String] ?? [:]
            connectionOperationState.withLock { state in
                state.answers.append(["action": action, "target": target])
                state.env.merge(env) { $1 }
                switch action {
                case "skip": state.states[target] = "skipped"
                case "approve", "retry": state.states[target] = "connected"
                case "continue": state.settled = true
                default: break
                }
                let resolved = state.states.values.allSatisfy { $0 == "connected" || $0 == "skipped" }
                if resolved { state.settled = true }
            }
        }
        return json(connectionOperationFixture())
    }

    static func connectionOperationFixture() -> [String: Any] {
        let state = connectionOperationState.withLock { $0 }
        func row(_ name: String, _ title: String, _ kind: String, url: String? = nil, launch: Any = NSNull(), fields: [[String: Any]] = [], detail: String = "") -> [String: Any] {
            let current = state.states[name] ?? ""
            let open = !state.settled
            var actions: [String] = []
            if open, current == "pending" { actions.append("approve") }
            if open, current == "failed" { actions.append("retry") }
            if open, ["pending", "initiated", "failed"].contains(current) { actions.append("skip") }
            return [
                "name": name, "title": title, "kind": kind, "state": current, "detail": detail,
                "connect_url": open && current == "initiated" ? (url ?? NSNull()) as Any : NSNull(),
                "launch": open && current == "pending" ? launch : NSNull(),
                "actions": actions,
                "env_fields": open && current == "pending" ? fields : []
            ]
        }
        let connected = state.states.values.allSatisfy { $0 == "connected" }
        return [
            "op_id": "op-fixture", "settled": state.settled, "tool_call_id": "call-fixture",
            "outcome": state.settled ? (connected ? "connected" : "not_connected") as Any : NSNull(),
            "can_continue": !state.settled,
            "owner": ["session_id": sessionID, "authority_epoch": 1],
            "can_wake": !state.settled && state.states.values.contains("initiated"),
            "targets": [
                row("gmail", "Gmail", "connector", url: "https://vendor.example.test/authorize/fixture"),
                row("linear", "Linear", "mcp",
                    launch: ["kind": "stdio", "target": "npx -y mcp-linear --api-key=***", "env": ["LINEAR_API_KEY"], "cwd": "/workspace/linear"],
                    fields: [["name": "LINEAR_API_KEY", "label": "API key", "required": true, "secret": true]]),
                row("notion", "Notion", "connector", detail: state.states["notion"] == "failed" ? "The link expired" : "")
            ]
        ]
    }
}
#endif
