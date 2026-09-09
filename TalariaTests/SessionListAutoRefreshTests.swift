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
            isRefreshInFlight: { false },
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
            isRefreshInFlight: { false },
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
            isRefreshInFlight: { false },
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

    func testTickIsDroppedWhileAListLoadIsAlreadyInFlight() async {
        var refreshCount = 0
        var tickCount = 0
        var isRefreshInFlight = true

        await SessionListAutoRefresh.run(
            refreshesImmediately: true,
            isRefreshInFlight: { isRefreshInFlight },
            refresh: { refreshCount += 1 },
            sleep: { _ in
                tickCount += 1
                // The in-flight load finishes during the first wait; the loop must
                // have skipped its own request rather than racing it.
                isRefreshInFlight = false
                guard tickCount < 2 else { throw CancellationError() }
            }
        )

        XCTAssertEqual(tickCount, 2)
        XCTAssertEqual(refreshCount, 1)
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
            isRefreshInFlight: { viewModel.isLoading },
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
