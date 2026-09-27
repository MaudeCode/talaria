import XCTest
@testable import Talaria

@MainActor
final class SessionListAutoRefreshTests: XCTestCase {

    // MARK: - Start and cancellation gates

    func testLoopRunsOnlyForAnActiveSceneShowingTheList() {
        XCTAssertTrue(makeTaskID(isSceneActive: true, isListVisible: true).isEnabled)
        XCTAssertFalse(makeTaskID(isSceneActive: false, isListVisible: true).isEnabled)
        XCTAssertFalse(makeTaskID(isSceneActive: true, isListVisible: false).isEnabled)
        XCTAssertFalse(makeTaskID(isSceneActive: false, isListVisible: false).isEnabled)
    }

    /// Backgrounding, foregrounding and pushing a compact destination each change
    /// the id, which is what restarts or tears down the `.task` that owns the loop.
    func testTaskIDChangesWithScenePhaseVisibilityAndServer() throws {
        let base = makeTaskID(isSceneActive: true, isListVisible: true)

        XCTAssertNotEqual(base, makeTaskID(isSceneActive: false, isListVisible: true))
        XCTAssertNotEqual(base, makeTaskID(isSceneActive: true, isListVisible: false))
        XCTAssertNotEqual(
            base,
            makeTaskID(
                isSceneActive: true,
                isListVisible: true,
                server: try XCTUnwrap(URL(string: "https://other.test"))
            )
        )
        XCTAssertEqual(base, makeTaskID(isSceneActive: true, isListVisible: true))
    }

    func testCancellingTheWaitEndsTheLoop() async {
        var refreshCount = 0

        await SessionListAutoRefresh.run(
            refreshesImmediately: false,
            refresh: { refreshCount += 1 },
            sleep: { _ in throw CancellationError() }
        )

        XCTAssertEqual(refreshCount, 0)
    }

    // MARK: - Cadence and foregrounding

    /// Cold start: the initial-load task already owns the first request, so the
    /// loop waits out an interval before adding one of its own.
    func testColdStartWaitsBeforeItsFirstRefresh() async {
        var events: [Event] = []

        await SessionListAutoRefresh.run(
            refreshesImmediately: false,
            refresh: { events.append(.refreshed) },
            sleep: { interval in
                guard events.count < 2 else { throw CancellationError() }
                events.append(.slept(interval))
            }
        )

        XCTAssertEqual(
            events,
            [.slept(SessionListAutoRefresh.interval), .refreshed]
        )
    }

    /// Foregrounding restarts the loop, and the rows on screen are as old as the
    /// time spent in the background, so the first tick must not wait.
    func testForegroundRestartRefreshesBeforeWaiting() async {
        var events: [Event] = []

        await SessionListAutoRefresh.run(
            refreshesImmediately: true,
            refresh: { events.append(.refreshed) },
            sleep: { interval in
                guard events.count < 3 else { throw CancellationError() }
                events.append(.slept(interval))
            }
        )

        XCTAssertEqual(
            events,
            [.refreshed, .slept(SessionListAutoRefresh.interval), .refreshed]
        )
    }

    // MARK: - Deduplication

    /// The loop must not drop a tick before it reaches the queue. The queue
    /// coalesces what reaches it, but a trigger dropped early is never recorded,
    /// and the load already running may predate the change it is reacting to.
    func testEveryTickReachesTheRefreshPath() async {
        var refreshCount = 0
        var tickCount = 0

        await SessionListAutoRefresh.run(
            refreshesImmediately: true,
            refresh: { refreshCount += 1 },
            sleep: { _ in
                tickCount += 1
                guard tickCount < 2 else { throw CancellationError() }
            }
        )

        XCTAssertEqual(tickCount, 2)
        XCTAssertEqual(refreshCount, 2)
    }

    // MARK: - Refresh queue

    func testQuietReloadRunsExactlyOnce() async {
        let queue = SessionListRefreshQueue()
        var refreshCount = 0

        await queue.run { refreshCount += 1 }

        XCTAssertEqual(refreshCount, 1)
    }

    /// A trigger arriving mid-reload is not discarded: the reload in flight may
    /// predate the change it is reacting to, so one follow-up runs after it.
    func testRequestArrivingDuringAReloadRunsAsOneFollowUp() async {
        let queue = SessionListRefreshQueue()
        var refreshCount = 0

        await queue.run {
            refreshCount += 1
            guard refreshCount == 1 else { return }
            await queue.run { XCTFail("a second caller must not start its own reload") }
        }

        XCTAssertEqual(refreshCount, 2)
    }

    func testRequestsArrivingDuringAReloadCoalesceIntoOneFollowUp() async {
        let queue = SessionListRefreshQueue()
        var refreshCount = 0

        await queue.run {
            refreshCount += 1
            guard refreshCount == 1 else { return }
            for _ in 0..<3 {
                await queue.run { XCTFail("a second caller must not start its own reload") }
            }
        }

        XCTAssertEqual(refreshCount, 2)
    }

    func testFollowUpIsNotRepeatedByTheNextRequest() async {
        let queue = SessionListRefreshQueue()
        var refreshCount = 0

        await queue.run {
            refreshCount += 1
            guard refreshCount == 1 else { return }
            await queue.run {}
        }
        XCTAssertEqual(refreshCount, 2)

        await queue.run { refreshCount += 1 }

        XCTAssertEqual(refreshCount, 3)
    }

    /// SwiftUI replaces these `.task(id:)` owners constantly. Cancelling one must
    /// not abandon the reload it started, because the request it was serving
    /// would then have no owner left to finish it.
    func testCancellationDoesNotAbandonAReloadPartWay() async {
        let queue = SessionListRefreshQueue()
        var completedReloads = 0

        let caller = Task {
            await queue.run {
                withUnsafeCurrentTask { $0?.cancel() }
                await Task.yield()
                completedReloads += 1
            }
        }
        caller.cancel()
        await caller.value

        XCTAssertEqual(completedReloads, 1)
    }

    /// A replacement owner records its request and is turned away, so the caller
    /// already serving has to drain it — including after its own task is
    /// cancelled, which is exactly what replacing it does.
    func testServingCallerDrainsATurnedAwayRequestDespiteCancellation() async {
        let queue = SessionListRefreshQueue()
        var refreshCount = 0

        let owner = Task {
            await queue.run {
                refreshCount += 1
                guard refreshCount == 1 else { return }
                await queue.run { XCTFail("a turned-away caller must not start its own reload") }
            }
        }
        owner.cancel()
        await owner.value

        XCTAssertEqual(refreshCount, 2)
    }

    // MARK: - Notification-driven refresh

    /// The banner is the phone learning a run finished, which beats the next
    /// tick. Only a notification naming a session says anything about the list.
    func testOnlyASessionNotificationTriggersARefresh() {
        XCTAssertTrue(SessionNotificationRefresh.namesASession(userInfo: ["sessionId": "abc"]))
        XCTAssertFalse(SessionNotificationRefresh.namesASession(userInfo: [:]))
        XCTAssertFalse(SessionNotificationRefresh.namesASession(userInfo: ["sessionId": ""]))
        XCTAssertFalse(SessionNotificationRefresh.namesASession(userInfo: ["sessionId": "   "]))
        XCTAssertFalse(SessionNotificationRefresh.namesASession(userInfo: ["sessionId": 42]))
        XCTAssertFalse(SessionNotificationRefresh.namesASession(userInfo: ["publisherId": "pub"]))
    }

    // MARK: - Reconciliation and transient failure

    func testAutomaticRefreshAdoptsASessionCreatedElsewhere() async throws {
        let responses = SessionListResponses(bodies: [
            #"{"sessions":[{"session_id":"existing","title":"Existing","archived":false}]}"#,
            #"""
            {"sessions":[
              {"session_id":"existing","title":"Renamed remotely","archived":false},
              {"session_id":"from-webhook","title":"Webhook run","archived":false}
            ]}
            """#
        ])
        let viewModel = try makeViewModel(responses: responses)
        defer { MockURLProtocol.requestHandler = nil }

        await viewModel.load()
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["existing"])

        await runOneTick(refreshing: viewModel)

        XCTAssertEqual(
            viewModel.sessions.compactMap(\.sessionId),
            ["existing", "from-webhook"]
        )
        XCTAssertEqual(viewModel.sessions.first?.title, "Renamed remotely")
        XCTAssertNil(viewModel.errorMessage)
    }

    /// TAL-250: each refresh (return, foreground or tick) shows the server's run state: idle, a run started on
    /// another client, then its completion.
    func testRefreshFollowsTheServersRunStateFromIdleThroughRunningToCompleted() async throws {
        let responses = SessionListResponses(bodies: [
            #"{"sessions":[{"session_id":"existing","title":"Existing","archived":false,"is_streaming":false}]}"#,
            #"{"sessions":[{"session_id":"existing","title":"Existing","archived":false,"is_streaming":true,"active_stream_id":"stream-elsewhere"}]}"#,
            #"{"sessions":[{"session_id":"existing","title":"Existing","archived":false,"is_streaming":false,"active_stream_id":null}]}"#
        ])
        let viewModel = try makeViewModel(responses: responses)
        defer { MockURLProtocol.requestHandler = nil }

        await viewModel.load()
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false)

        await runOneTick(refreshing: viewModel)
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, true)
        XCTAssertEqual(viewModel.sessions.first?.activeStreamId, "stream-elsewhere")

        await runOneTick(refreshing: viewModel)
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false)
        XCTAssertNil(viewModel.sessions.first?.activeStreamId)
    }

    func testTransientFailureKeepsTheLastGoodListAndTheNextTickRecovers() async throws {
        let responses = SessionListResponses(
            bodies: [
                #"{"sessions":[{"session_id":"existing","title":"Existing","archived":false}]}"#,
                "",
                #"{"sessions":[{"session_id":"existing","title":"Existing","archived":false},{"session_id":"later","title":"Later","archived":false}]}"#
            ],
            failingResponseIndexes: [1]
        )
        let viewModel = try makeViewModel(responses: responses)
        defer { MockURLProtocol.requestHandler = nil }

        await viewModel.load()

        await runOneTick(refreshing: viewModel)

        // Rows stay put, and the failure is not surfaced over a list that still
        // has content to show.
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["existing"])
        XCTAssertFalse(viewModel.sessions.isEmpty)
        XCTAssertNotNil(viewModel.lastError)

        await runOneTick(refreshing: viewModel)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["existing", "later"])
        XCTAssertNil(viewModel.lastError)
        XCTAssertNil(viewModel.errorMessage)
    }

    /// `actionErrorMessage` is presented as a modal, so only a projects reload
    /// the user actually asked for may fail into it. A reload that is a side
    /// effect of refreshing the list — every initial load, pull-to-refresh,
    /// return and automatic tick — must stay silent, or a transient
    /// `/api/projects` failure interrupts the user once per refresh.
    func testOnlyAUserRequestedProjectsLoadReachesTheModalAlertChannel() async throws {
        let responses = SessionListResponses(
            bodies: ["", "", ""],
            failingResponseIndexes: [0, 1, 2]
        )
        let viewModel = try makeViewModel(responses: responses)
        defer { MockURLProtocol.requestHandler = nil }

        await viewModel.load()

        XCTAssertNotNil(viewModel.lastError)
        XCTAssertNil(
            viewModel.actionErrorMessage,
            "a failed session list must not raise the user-action modal"
        )

        await viewModel.loadProjects(silently: true)

        XCTAssertNotNil(viewModel.lastError, "the failure is still recorded")
        XCTAssertNil(
            viewModel.actionErrorMessage,
            "a projects reload behind a list refresh must not raise the modal"
        )

        await viewModel.loadProjects()

        XCTAssertNotNil(
            viewModel.actionErrorMessage,
            "an explicitly requested projects reload still reports its failure"
        )
    }

    /// The alert binding tests `actionErrorMessage != nil`, so clearing it during
    /// a refresh the user did not ask for dismisses a failure they have not read.
    func testSilentProjectsReloadPreservesAPendingActionAlert() async throws {
        let responses = SessionListResponses(bodies: [""], failingResponseIndexes: [0])
        let viewModel = try makeViewModel(responses: responses)
        defer { MockURLProtocol.requestHandler = nil }

        // A user action has failed and its modal is on screen.
        await viewModel.loadProjects()
        let pendingAlert = try XCTUnwrap(viewModel.actionErrorMessage)

        // An automatic tick arrives before the user has acknowledged it.
        await viewModel.loadProjects(silently: true)

        XCTAssertEqual(viewModel.actionErrorMessage, pendingAlert)
    }

    // MARK: - Support

    private enum Event: Equatable {
        case slept(Duration)
        case refreshed
    }

    private func makeTaskID(
        isSceneActive: Bool,
        isListVisible: Bool,
        server: URL = URL(string: "https://example.test")!
    ) -> SessionListAutoRefresh.TaskID {
        SessionListAutoRefresh.TaskID(
            server: server,
            isSceneActive: isSceneActive,
            isListVisible: isListVisible
        )
    }

    /// Drives exactly one automatic refresh through the real loop, so these cases
    /// exercise the same gate and call path the view uses.
    private func runOneTick(refreshing viewModel: SessionListViewModel) async {
        await SessionListAutoRefresh.run(
            refreshesImmediately: true,
            refresh: { await viewModel.load() },
            sleep: { _ in throw CancellationError() }
        )
    }

    private func makeViewModel(responses: SessionListResponses) throws -> SessionListViewModel {
        MockURLProtocol.requestHandler = { _ in try responses.next() }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = APIClient(baseURL: server, session: URLSession(configuration: configuration))

        return SessionListViewModel(server: server, client: client)
    }
}

/// Hands out one scripted session-list response per request, so a test owns the
/// exact sequence the refresh loop sees.
private final class SessionListResponses: @unchecked Sendable {
    private let bodies: [String]
    private let failingResponseIndexes: Set<Int>
    private let lock = NSLock()
    private var index = 0

    init(bodies: [String], failingResponseIndexes: Set<Int> = []) {
        self.bodies = bodies
        self.failingResponseIndexes = failingResponseIndexes
    }

    func next() throws -> (HTTPURLResponse, Data) {
        lock.lock()
        let current = index
        index += 1
        lock.unlock()

        guard current < bodies.count else {
            throw URLError(.badServerResponse)
        }

        let response = HTTPURLResponse(
            url: URL(string: "https://example.test/api/sessions")!,
            statusCode: failingResponseIndexes.contains(current) ? 500 : 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!

        return (response, Data(bodies[current].utf8))
    }
}
