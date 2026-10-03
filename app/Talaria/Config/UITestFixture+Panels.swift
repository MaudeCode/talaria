#if DEBUG
import Foundation

/// Deterministic Tasks, Kanban, Skills, Memory and Insights payloads for the agent-panel
/// smoke journeys (TAL-71). Without one of these arguments the fixture keeps serving the
/// responses the chat, sidebar and Kanban journeys already rely on.
enum UITestPanelScenario: String, CaseIterable {
    case populated = "--ui-test-panels"
    /// Fails each panel's first load so a journey can walk the error state and recover
    /// through Try Again; every later request serves the `populated` payload, and the retry is
    /// held like a populated first load so its loading state shows too.
    case failing = "--ui-test-panels-error"

    static var current: Self? {
        let arguments = ProcessInfo.processInfo.arguments
        return allCases.first { arguments.contains($0.rawValue) }
    }
}

/// Fixture-owned panel state: which loads already failed or were held once, which Skills the
/// journey disabled, and which Memory sections it saved.
final class UITestPanelFixtureState: @unchecked Sendable {
    static let shared = UITestPanelFixtureState()

    private let lock = NSLock()
    private var failedPaths: Set<String> = []
    private var delayedPaths: Set<String> = []
    private var disabledSkills: Set<String> = ["fixture-archivist"]
    private var memoryOverrides: [String: String] = [:]

    /// True once per path, so the retry of the same load succeeds.
    func consumeFailure(for path: String) -> Bool {
        lock.withLock { failedPaths.insert(path).inserted }
    }

    /// True once per path, so only a panel's first load renders its loading state.
    func consumeDelay(for path: String) -> Bool {
        lock.withLock { delayedPaths.insert(path).inserted }
    }

    func setSkill(_ name: String, disabled: Bool) {
        lock.withLock {
            if disabled {
                disabledSkills.insert(name)
            } else {
                disabledSkills.remove(name)
            }
        }
    }

    func isSkillDisabled(_ name: String) -> Bool {
        lock.withLock { disabledSkills.contains(name) }
    }

    func writeMemory(section: String, content: String) {
        lock.withLock { memoryOverrides[section] = content }
    }

    func memory(_ section: String, fallback: String) -> String {
        lock.withLock { memoryOverrides[section] ?? fallback }
    }
}

extension UITestFixtureURLProtocol {
    /// Panel loads the failing scenario breaks once.
    private static let panelFailurePaths: Set<String> = [
        "/api/crons",
        "/api/crons/status",
        "/api/skills",
        "/api/memory",
        "/api/insights",
        "/api/kanban/board"
    ]

    /// Panel loads held once so their loading state is observable. `/api/crons/status` is
    /// excluded: it resolves with `/api/crons`, and holding both only doubles the wait.
    private static let panelDelayPaths: Set<String> = [
        "/api/crons",
        "/api/skills",
        "/api/memory",
        "/api/insights",
        "/api/kanban/board"
    ]

    static func panelRequestFailure(for url: URL) -> Error? {
        guard UITestPanelScenario.current == .failing else { return nil }
        let state = UITestPanelFixtureState.shared

        switch url.path {
        case "/api/kanban/board":
            // The Board's incremental poll carries `since=`; only the full load is broken.
            guard url.query?.contains("since=") != true else { return nil }
            return state.consumeFailure(for: url.path) ? URLError(.cannotConnectToHost) : nil
        default:
            guard panelFailurePaths.contains(url.path) else { return nil }
            return state.consumeFailure(for: url.path) ? URLError(.cannotConnectToHost) : nil
        }
    }

    /// Whether to hold a panel's first load until the UI test has seen its loading state
    /// (TAL-401); a fixed stall let a slow runner miss it.
    static func holdsPanelLoad(for url: URL) -> Bool {
        [.populated, .failing].contains(UITestPanelScenario.current)
            && panelDelayPaths.contains(url.path)
            && url.query?.contains("since=") != true
            && UITestPanelFixtureState.shared.consumeDelay(for: url.path)
    }

    static func panelResponseData(for request: URLRequest, url: URL) -> Data? {
        guard UITestPanelScenario.current != nil else { return nil }
        let state = UITestPanelFixtureState.shared

        switch url.path {
        case "/api/crons":
            return body(changedWhileBackgrounded ? cronsWithJobAddedElsewhere : populatedCrons)
        case "/api/crons/status":
            return body(#"{"running":{"ui-fixture-cron-digest":42.5}}"#)
        case "/api/crons/output":
            return body(cronOutputs)
        case "/api/crons/history":
            return body(cronHistory)
        case "/api/crons/run" where request.httpMethod == "GET":
            return body(cronRunDetail)
        case "/api/crons/delivery-options":
            return body(#"{"platforms":[{"value":"local","label":"Local"}]}"#)
        case "/api/crons/recent":
            return body(cronRecentCompletions)
        case "/api/skills":
            return body(skills(state))
        case "/api/skills/content":
            return body(skillContent(for: url))
        case "/api/skills/toggle":
            return body(toggleSkill(request, state: state))
        case "/api/memory":
            return body(memory(state))
        case "/api/memory/write":
            return body(writeMemory(request, state: state))
        case "/api/insights":
            return body(populatedInsights)
        default:
            return nil
        }
    }

    private static func body(_ json: String) -> Data { Data(json.utf8) }

    // MARK: - Tasks

    private static let populatedCrons = """
    {"jobs":[
      {"id":"ui-fixture-cron-digest","name":"Fixture Nightly Digest","prompt":"Summarize the deterministic fixture run.","schedule":"0 3 * * *","schedule_display":"Every day at 03:00","enabled":true,"state":"active","next_run_at":2000003600,"last_run_at":2000000000,"last_status":"success","deliver":"local","skills":["fixture-runner"],"model":"fixture-model","provider":"fixture-provider","profile":"fixture-profile","toast_notifications":true},
      {"id":"ui-fixture-cron-sweep","name":"Fixture Weekly Sweep","prompt":"Sweep the deterministic fixture workspace.","schedule":"0 4 * * 1","schedule_display":"Every Monday at 04:00","enabled":false,"state":"paused","next_run_at":2000090000,"last_status":"paused","deliver":"local","toast_notifications":false}
    ]}
    """

    private static let cronsWithJobAddedElsewhere = populatedCrons.replacingOccurrences(
        of: "\n]}",
        with: #",{"id":"ui-fixture-cron-elsewhere","name":"FixtureJobAddedElsewhere","prompt":"Added by another client.","schedule":"0 5 * * *","schedule_display":"Every day at 05:00","enabled":true,"state":"active","deliver":"local"}"# + "\n]}"
    )

    private static let cronOutputs = """
    {"job_id":"ui-fixture-cron-digest","outputs":[
      {"filename":"fixture-digest.md","content":"Deterministic fixture digest output."}
    ]}
    """

    private static let cronRecentCompletions = """
    {"completions":[
      {"job_id":"ui-fixture-cron-sweep","name":"Fixture Weekly Sweep","status":"error","outcome":"failed","completed_at":1999990000,"toast_notifications":false,"session_id":""}
    ],"since":0}
    """

    private static let cronHistory = """
    {"job_id":"ui-fixture-cron-digest","runs":[
      {"filename":"fixture-digest.md","size":42,"modified":2000000000,"usage":{"model":"fixture-model","total_tokens":1200}}
    ],"total":1,"offset":0}
    """

    private static let cronRunDetail = """
    {"job_id":"ui-fixture-cron-digest","filename":"fixture-digest.md",\
    "content":"# Run\\n\\n## Response\\n\\nDeterministic fixture digest output.","snippet":"Deterministic fixture digest output.","usage":{}}
    """

    // MARK: - Skills

    private static func skills(_ state: UITestPanelFixtureState) -> String {
        let rows = [
            ("fixture-runner", "Fixture", "Runs the deterministic fixture journey."),
            ("fixture-archivist", "Fixture", "Archives deterministic fixture output."),
            ("fixture-reviewer", "Review", "Reviews the deterministic fixture slice.")
        ].map { name, category, description in
            """
            {"name":"\(name)","category":"\(category)","description":"\(description)",\
            "path":"/fixture/skills/\(name)/SKILL.md","disabled":\(state.isSkillDisabled(name)),\
            "tags":["fixture"]}
            """
        }
        return "{\"skills\":[" + rows.joined(separator: ",") + "]}"
    }

    private static func skillContent(for url: URL) -> String {
        let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "name" }?.value ?? "fixture-runner"
        return """
        {"name":"\(name)","content":"# \(name)\\n\\nDeterministic fixture skill content.","linked_files":[]}
        """
    }

    private static func toggleSkill(_ request: URLRequest, state: UITestPanelFixtureState) -> String {
        let payload = requestJSON(request)
        if let name = payload["name"] as? String {
            state.setSkill(name, disabled: (payload["enabled"] as? Bool) == false)
        }
        return #"{"ok":true}"#
    }

    // MARK: - Memory

    private static func memory(_ state: UITestPanelFixtureState) -> String {
        let sections = [
            ("memory", "Fixture notes body."),
            ("user", "Fixture user profile."),
            ("soul", "Fixture agent soul.")
        ].map { section, fallback in
            "\"\(section)\":\"" + escaped(state.memory(section, fallback: fallback)) + "\""
        }
        return "{" + sections.joined(separator: ",")
            + #","memory_mtime":2000000000,"user_mtime":2000000000,"soul_mtime":2000000000}"#
    }

    private static func writeMemory(_ request: URLRequest, state: UITestPanelFixtureState) -> String {
        let payload = requestJSON(request)
        if let section = payload["section"] as? String, let content = payload["content"] as? String {
            state.writeMemory(section: section, content: content)
        }
        return #"{"ok":true}"#
    }

    /// The panel payloads are hand-written JSON, so saved Memory text has to be re-escaped.
    private static func escaped(_ value: String) -> String {
        let encoded = try! JSONSerialization.data(withJSONObject: [value], options: [])
        let array = String(decoding: encoded, as: UTF8.self)
        return String(array.dropFirst(2).dropLast(2))
    }

    // MARK: - Insights

    private static let populatedInsights = """
    {"period_days":30,"total_sessions":42,"total_messages":128,"total_input_tokens":4321,\
    "total_output_tokens":8765,"total_tokens":13086,"total_cost":12.34,\
    "models":[],"daily_tokens":[],"activity_by_day":[],"activity_by_hour":[]}
    """

    // MARK: - Kanban

}
#endif
