#if DEBUG
import Foundation
import notify

/// TAL-80: one run on a server that outlives the app. The run's state is kept on disk, so a
/// journey can background the app, kill it, relaunch it, drop its connection or expire its
/// session, and the server still answers from where the run really is. The UI test drives the
/// run with Darwin notifications: `dropNotification` cuts the live stream, `finishNotification`
/// ends the run on the server whether or not a stream is attached.
enum UITestLifecycleFixture {
    static let argument = "--ui-test-chat-lifecycle"
    /// After a drop, the next status checks are refused, time out, then answer 503 before the
    /// server is reachable again.
    static let unreachableArgument = "--ui-test-lifecycle-unreachable"
    /// After a drop, the sign-in session has expired: every API request answers 401 until the
    /// user signs in again.
    static let sessionExpiryArgument = "--ui-test-lifecycle-session-expiry"
    /// Match `StreamLifecycleUITests` in the UI tests.
    static let dropNotification = "dev.kil.talaria.ui-test.lifecycle-drop"
    static let finishNotification = "dev.kil.talaria.ui-test.lifecycle-finish"

    static let streamID = "ui-fixture-lifecycle-stream"
    static let prompt = "Run the lifecycle fixture"
    static let opening = "Lifecycle opening."
    static let finished = " Lifecycle finished."

    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains(argument)
    }

    static func has(_ argument: String) -> Bool {
        ProcessInfo.processInfo.arguments.contains(argument)
    }

    /// The run journal: `seq` 1 is out as soon as the run starts; 2 and 3 only once it finishes.
    static func journal(finished: Bool) -> [(seq: Int, event: String, payload: [String: Any])] {
        let opening = [(seq: 1, event: "token", payload: ["text": opening] as [String: Any])]
        guard finished else { return opening }
        return opening + [(2, "token", ["text": Self.finished]), (3, "done", [:])]
    }
}

/// The fixture server's state for the lifecycle run. What a real server would remember lives in
/// `Run` and is written to disk on every change; drops and stop wake-ups are per process.
final class UITestLifecycleServer: @unchecked Sendable {
    static let shared = UITestLifecycleServer()

    enum StatusFailure: String, Codable {
        case refused, timeout, unavailable
    }

    struct Run: Codable {
        var starts = 0
        var finished = false
        var expired = false
        /// Stream connections this run has served; only the first attaches from the start.
        var connections = 0
        var statusFailures: [StatusFailure] = []
    }

    private let condition = NSCondition()
    private var run: Run
    private var drops = 0
    private var tokens: [Int32] = [0, 0]
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("ui-test-lifecycle-run.json")

    private init() {
        if !UITestFixtureEnvironment.keepsCachesAcrossLaunches { try? FileManager.default.removeItem(at: url) }
        run = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Run.self, from: $0) } ?? Run()
    }

    func listen() {
        notify_register_dispatch(UITestLifecycleFixture.dropNotification, &tokens[0], .global()) { [weak self] _ in
            self?.drop()
        }
        notify_register_dispatch(UITestLifecycleFixture.finishNotification, &tokens[1], .global()) { [weak self] _ in
            self?.update { $0.finished = true }
        }
    }

    var snapshot: Run {
        condition.withLock { run }
    }

    var dropCount: Int {
        condition.withLock { drops }
    }

    @discardableResult
    func update<T>(_ change: (inout Run) -> T) -> T {
        condition.lock()
        defer { condition.unlock() }
        let result = change(&run)
        try? JSONEncoder().encode(run).write(to: url, options: .atomic)
        condition.broadcast()
        return result
    }

    /// Waits up to `timeout` for `predicate`, or for a stopped connection's wake-up.
    func wait(timeout: TimeInterval, until predicate: (Run, Int) -> Bool) {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate(run, drops), condition.wait(until: deadline) {}
    }

    func wake() {
        condition.withLock { condition.broadcast() }
    }

    /// Arms what the server does after the drop before the stream sees it, so the app's first
    /// recovery request already meets it.
    private func drop() {
        update { run in
            if UITestLifecycleFixture.has(UITestLifecycleFixture.unreachableArgument) {
                run.statusFailures = [.refused, .timeout, .unavailable]
            }
            if UITestLifecycleFixture.has(UITestLifecycleFixture.sessionExpiryArgument) {
                run.expired = true
            }
        }
        condition.withLock {
            drops += 1
            condition.broadcast()
        }
    }
}

extension UITestFixtureURLProtocol {
    /// Answers every request the lifecycle run owns; false leaves the request to the shared fixture.
    func handleLifecycleRequest(_ url: URL) -> Bool {
        guard UITestLifecycleFixture.isEnabled else { return false }
        let server = UITestLifecycleServer.shared
        let authPaths: Set<String> = ["/api/auth/status", "/api/auth/login", "/health"]
        if server.snapshot.expired, !authPaths.contains(url.path) {
            respond(url, status: 401, data: Self.json(["error": "unauthorized"]))
            return true
        }
        switch url.path {
        case "/api/auth/status" where UITestLifecycleFixture.has(UITestLifecycleFixture.sessionExpiryArgument):
            respond(url, data: Self.json([
                "auth_enabled": true, "logged_in": !server.snapshot.expired, "password_auth_enabled": true
            ]))
        case "/api/auth/login" where UITestLifecycleFixture.has(UITestLifecycleFixture.sessionExpiryArgument):
            server.update { $0.expired = false }
            respond(url, data: Self.json(["ok": true]), headers: ["Set-Cookie": "hermes_session=fixture-renewed; Path=/; Secure; HttpOnly"])
        case "/api/chat/start":
            server.update { $0.starts += 1 }
            respond(url, data: Self.json(["stream_id": UITestLifecycleFixture.streamID, "session_id": Self.sessionID]))
        case "/api/chat/stream/status":
            switch server.update({ $0.statusFailures.isEmpty ? nil : $0.statusFailures.removeFirst() }) {
            case .refused?:
                client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            case .timeout?:
                client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            case .unavailable?:
                respond(url, status: 503, data: Data("Service Unavailable".utf8))
            case nil:
                let run = server.snapshot
                respond(url, data: Self.json([
                    "active": run.starts > 0 && !run.finished,
                    "stream_id": UITestLifecycleFixture.streamID,
                    "replay_available": false
                ]))
            }
        case "/api/session":
            respond(url, data: Self.lifecycleSessionResponse(server.snapshot))
        case "/api/chat/stream":
            let afterSeq = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "after_seq" }?.value.flatMap(Int.init)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.runLifecycleStream(afterSeq: afterSeq)
            }
        default:
            return false
        }
        return true
    }

    /// The server's transcript: one prompt per run it started, the reply once the run finished,
    /// and while it runs, a cursor saying the transcript holds none of the run's output yet.
    private static func lifecycleSessionResponse(_ run: UITestLifecycleServer.Run) -> Data {
        var detail = session(id: sessionID, title: sessionTitle)
        var messages: [[String: Any]] = (0..<run.starts).map { index in
            ["role": "user", "content": UITestLifecycleFixture.prompt, "message_id": "lifecycle-user-\(index)",
             "_ts": 2_000_000_100 + index, "_turn_id": UITestLifecycleFixture.streamID]
        }
        if run.finished, run.starts > 0 {
            messages.append([
                "role": "assistant", "content": UITestLifecycleFixture.opening + UITestLifecycleFixture.finished,
                "message_id": "lifecycle-assistant", "_ts": 2_000_000_200, "_turn_id": UITestLifecycleFixture.streamID
            ])
        }
        let active = run.starts > 0 && !run.finished
        detail["messages"] = messages
        detail["message_count"] = messages.count
        detail["active_stream_id"] = active ? UITestLifecycleFixture.streamID : NSNull()
        detail["transcript_seq"] = active ? ["stream_id": UITestLifecycleFixture.streamID, "seq": 0] : NSNull()
        return json(["session": detail])
    }

    /// Replays the journal after `afterSeq`; without one, the run's first connection gets it all
    /// and a later live attach only what comes next. Heartbeats keep the attached stream fresh.
    private func runLifecycleStream(afterSeq: Int?) {
        let server = UITestLifecycleServer.shared
        let drops = server.dropCount
        var cursor = server.update { run -> Int in
            defer { run.connections += 1 }
            return afterSeq ?? (run.connections == 0 ? 0 : UITestLifecycleFixture.journal(finished: run.finished).count)
        }
        while !isStopped {
            let run = server.snapshot
            let events = UITestLifecycleFixture.journal(finished: run.finished).filter { $0.seq > cursor }
            sendJournal(events)
            cursor = events.last?.seq ?? cursor
            if run.finished {
                sendJournal([], terminator: "event: stream_end\ndata: {}\n\n")
                guard !isStopped else { return }
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            server.wait(timeout: 3) { run, currentDrops in run.finished || currentDrops != drops || self.isStopped }
            if server.dropCount != drops {
                guard !isStopped else { return }
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            sendJournal([], terminator: ": heartbeat\n\n")
        }
    }

    private func sendJournal(_ events: [(seq: Int, event: String, payload: [String: Any])], terminator: String = "") {
        guard !isStopped else { return }
        var data = Data()
        for entry in events {
            data.append(Data("id: \(UITestLifecycleFixture.streamID):\(entry.seq)\nevent: \(entry.event)\ndata: ".utf8))
            data.append(Self.json(entry.payload))
            data.append(Data("\n\n".utf8))
        }
        data.append(Data(terminator.utf8))
        guard !data.isEmpty else { return }
        client?.urlProtocol(self, didLoad: data)
    }

    private func respond(_ url: URL, status: Int = 200, data: Data, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"].merging(headers) { $1 }
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
#endif
