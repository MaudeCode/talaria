#if DEBUG
import Foundation
import os

extension UITestFixtureURLProtocol {
    static let cronRunningElsewhereJobID = "fixture-cron-gateway"
    static let cronResponseWrapping = OSAllocatedUnfairLock<Bool?>(initialState: false)

    /// Tasks for `--ui-test-unwritable-cron-store` (TAL-835): an unwritable store, a job another process runs (absent
    /// from the status poll, which sees only this server's runs), and a recovered job that keeps its last failure.
    static func cronResponseData(for request: URLRequest) -> Data {
        let body: String
        switch request.url?.path {
        case "/api/crons" where ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.cronResponseWrappingArgument):
            return cronResponseWrapping.withLock { wrapping in
                json(["ordered": true, "jobs": [
                    cronWrappingJob(id: "fixture-digest", name: "Release digest", supported: true, wrapping: wrapping),
                    cronWrappingJob(id: "fixture-restricted", name: "Restricted digest", supported: true, wrapping: true),
                    cronWrappingJob(id: "fixture-legacy", name: "Legacy digest", supported: false, wrapping: nil)
                ]])
            }
        case "/api/crons/update" where ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.cronResponseWrappingArgument):
            let update = requestJSON(request)
            guard update["job_id"] as? String == "fixture-digest" else {
                return json(["ok": false, "error": "The server refused this task policy."])
            }
            let changesWrapping = update["wrap_response"] != nil
            let selected = update["wrap_response"] as? Bool
            return cronResponseWrapping.withLock { wrapping in
                if changesWrapping { wrapping = selected }
                return json(["ok": true, "job": cronWrappingJob(
                    id: "fixture-digest", name: "Release digest", supported: true, wrapping: wrapping
                )])
            }
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

    private static func cronWrappingJob(id: String, name: String, supported: Bool, wrapping: Bool?) -> [String: Any] {
        var job: [String: Any] = [
            "id": id, "name": name, "prompt": "Summarize releases.", "schedule_input": "0 7 * * *",
            "schedule_display": "0 7 * * *", "derived_state": "active", "deliver": "local"
        ]
        if id == "fixture-digest" {
            job["prompt"] = nil
            job["no_agent"] = true
            job["script"] = "digest.py"
        }
        if supported {
            job["wrap_response_supported"] = true
            job["wrap_response"] = wrapping.map { $0 as Any } ?? NSNull()
        }
        return job
    }
}
#endif
