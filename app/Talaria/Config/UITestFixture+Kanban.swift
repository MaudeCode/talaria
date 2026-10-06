#if DEBUG
import Foundation

extension UITestFixtureURLProtocol {
    private static var cardPathPrefix: String { "/api/kanban/tasks/" }

    /// A small compatible Board so the fixture's Kanban destination renders a populated Status Focus view.
    static func kanbanResponseData(for url: URL) -> Data {
        let body: String
        switch url.path {
        case "/api/kanban/config":
            body = #"{"columns":["triage","todo","ready","running","blocked","done"],"assignees":["fixture-builder","fixture-reviewer"],"read_only":false}"#
        case "/api/kanban/boards":
            // The current Board carries a long localized name so layout checks exercise the
            // narrow-bar case; the short Board gives the picker menu a second entry to select.
            body = ##"{"boards":[{"slug":"fixture","name":"Fixture Board","description":"Deterministic UI fixture","icon":"📋","color":"#5B8DEF","total":4},{"slug":"fixture-long","name":"Fixture Überprüfungs-Board mit einem absichtlich sehr langen Namen","description":"Deterministic long-name UI fixture","icon":"📐","color":"#EF8D5B","total":4}],"current":"fixture-long","read_only":false}"##
        case "/api/kanban/board" where url.query?.contains("since=") == true:
            body = #"{"changed":false,"latest_event_id":1,"read_only":false}"#
        case "/api/kanban/board":
            body = """
            {"changed":true,"latest_event_id":1,"read_only":false,"bulk_move_targets":["triage","todo","ready","blocked","done"],"tenants":["fixture"],"assignees":["fixture-builder","fixture-reviewer"],"columns":[
              {"name":"triage","tasks":[{"id":"FIXTURE-1","title":"Shape the fixture slice","status":"triage","assignee":null,"tenant":"fixture","priority":2,"comment_count":1,"link_counts":{"parents":0,"children":1},"age_seconds":300,"available_actions":{"block":false,"unblock":false,"complete":false,"archive":true,"move_to":["todo","ready"]},"requires_running_exit_confirmation":false}]},
              {"name":"todo","tasks":[]},
              {"name":"ready","tasks":[{"id":"FIXTURE-2","title":"Audit localized fixture copy","status":"ready","assignee":"fixture-reviewer","tenant":"fixture","priority":1,"comment_count":0,"link_counts":{"parents":1,"children":0},"age_seconds":1800,"available_actions":{"block":true,"unblock":false,"complete":true,"archive":true,"move_to":["triage","todo"]},"requires_running_exit_confirmation":false},{"id":"FIXTURE-3","title":"Implement the fixture Status Focus","status":"ready","assignee":"fixture-builder","tenant":"fixture","priority":0,"comment_count":2,"link_counts":{"parents":0,"children":0},"age_seconds":7200,"available_actions":{"block":true,"unblock":false,"complete":true,"archive":true,"move_to":["triage","todo"]},"requires_running_exit_confirmation":false}]},
              {"name":"running","tasks":[]},
              {"name":"blocked","tasks":[]},
              {"name":"done","tasks":[{"id":"FIXTURE-4","title":"Verify fixture read contracts","status":"done","assignee":"fixture-builder","tenant":"fixture","priority":0,"comment_count":0,"link_counts":{"parents":0,"children":0},"age_seconds":3600,"available_actions":{"block":false,"unblock":false,"complete":false,"archive":true,"move_to":["triage","todo","ready"]},"requires_running_exit_confirmation":false}]}
            ]}
            """
        case "/api/kanban/stats":
            body = #"{"by_status":{"triage":1,"ready":2,"done":1},"by_assignee":{"fixture-builder":2,"fixture-reviewer":1,"unassigned":1}}"#
        case "/api/kanban/assignees":
            body = #"{"assignees":["fixture-builder","fixture-reviewer"]}"#
        case "/api/kanban/events":
            body = #"{"events":[],"cursor":1,"latest_event_id":1,"read_only":false}"#
        case let path where path.hasPrefix(cardPathPrefix)
            && !path.dropFirst(cardPathPrefix.count).contains("/"):
            // Card detail for the pushed Card surface; the id echoes the requested Card so
            // any fixture Card opens without a per-Card payload.
            let cardID = String(path.dropFirst(cardPathPrefix.count))
            body = """
            {"read_only":false,"comments":[],"events":[],"runs":[],"links":{"parents":[],"children":[]},
             "task":{"id":"\(cardID)","title":"Fixture Card \(cardID)","status":"ready","assignee":"fixture-builder",
             "tenant":"fixture","priority":0,"description":"Deterministic fixture Card detail.",
             "comment_count":0,"link_counts":{"parents":0,"children":0},"age_seconds":7200,
             "available_actions":{"block":true,"unblock":false,"complete":true,"archive":true,"move_to":["triage","todo"]},"requires_running_exit_confirmation":false}}
            """
        default:
            body = "{}"
        }
        return Data(body.utf8)
    }
}
#endif
