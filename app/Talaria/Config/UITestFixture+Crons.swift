#if DEBUG
import Foundation

extension UITestFixtureURLProtocol {
    static let cronRunningElsewhereJobID = "fixture-cron-gateway"

    /// Tasks for `--ui-test-unwritable-cron-store` (TAL-835): an unwritable store, a job another process runs (absent
    /// from the status poll, which sees only this server's runs), and a recovered job that keeps its last failure.
    static func cronResponseData(for request: URLRequest) -> Data {
        let body: String
        switch request.url?.path {
        case "/api/cron/blueprints":
            body = #"{"blueprints":[{"key":"team:brief","title":"Team brief","description":"A daily digest of team releases.","category":"daily","source":"plugin","plugin":"team","schedule_label":"Daily at 09:00","slots":[{"name":"topic","type":"text","label":"Topic","default":null,"options":[],"optional":false,"strict":true,"help":""},{"name":"time","type":"time","label":"Time","default":"09:00","options":[],"optional":false,"strict":true,"help":""}]}]}"#
        case "/api/cron/blueprints/fill":
            body = #"{"draft":{"name":"Team brief","prompt":"Summarize team releases.","schedule":"30 8 * * *","deliver":"local","skills":["summary"]}}"#
        case "/api/crons" where ProcessInfo.processInfo.arguments.contains("--ui-test-cron-blueprints"):
            body = #"{"ordered":true,"active_profile":"default","jobs":[],"unwritable_stores":[]}"#
        case "/api/crons":
            body = """
            {"ordered": true, "active_profile": "default", "jobs": [
              {"id": "\(cronRunningElsewhereJobID)", "name": "Morning digest", "prompt": "Summarize overnight activity.",
               "schedule_display": "0 7 * * *", "schedule_input": "0 7 * * *", "derived_state": "active",
               "deliver": "local", "running": true, "last_failure": null},
              {"id": "fixture-cron-recovered", "name": "Inbox triage", "prompt": "Sort new mail into folders.",
               "schedule_display": "every 2h", "schedule_input": "every 2h", "derived_state": "active",
               "deliver": "local", "last_status": "ok", "last_run_at": 1791000000, "running": false,
               "last_failure": {"at": 1790990000, "detail": "Provider timed out after 120s"}}
            ], "unwritable_stores": [
              {"profile": "default", "store": "/fixture/.hermes/cron", "error": "[Errno 28] No space left on device",
               "fix": "Free disk space on the volume that holds the cron store.", "since": 1790980000}
            ]}
            """
        case "/api/crons/status" where request.url?.query?.contains("job_id=") == true:
            body = #"{"running": false, "elapsed": 0}"#
        case "/api/crons/status":
            body = #"{"running": {}}"#
        case "/api/crons/run" where request.httpMethod == "POST":
            body = #"{"ok": false, "job_id": "\#(cronRunningElsewhereJobID)", "status": "already_running", "elapsed": 42}"#
        case "/api/crons/history":
            body = #"{"runs": [], "total": 0, "offset": 0}"#
        case "/api/crons/recent":
            body = #"{"completions": [], "since": 0}"#
        case "/api/crons/delivery-options":
            body = #"{"platforms": []}"#
        default:
            body = #"{"outputs": []}"#
        }
        return Data(body.utf8)
    }
}
#endif
