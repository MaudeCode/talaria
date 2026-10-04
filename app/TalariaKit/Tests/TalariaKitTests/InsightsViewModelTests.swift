import XCTest
@testable import TalariaKit

final class InsightsViewModelTests: XCTestCase {
    func testTimeframesMapToServerInsightDays() {
        XCTAssertEqual(AnalyticsTimeframe.today.serverDays, 1)
        XCTAssertEqual(AnalyticsTimeframe.last7Days.serverDays, 7)
        XCTAssertEqual(AnalyticsTimeframe.last30Days.serverDays, 30)
        XCTAssertEqual(AnalyticsTimeframe.allTime.serverDays, 365)
    }

    func testModelDisplayShareFallsBackFromZeroCostShareToTokenShare() throws {
        let insights = try decodeInsights("""
        {
          "models": [
            {
              "model": "deepseek-v4-flash",
              "sessions": 25,
              "total_tokens": 3000000,
              "cost_share": 0,
              "token_share": 26,
              "session_share": 37
            }
          ]
        }
        """)

        XCTAssertEqual(insights.models?.first?.displayShare, 26)
    }

    @MainActor
    func testInsightsNeverAggregatesRowsWithoutUsableIDs() async throws {
        let now = Date().timeIntervalSince1970
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(SessionsResponse.self, from: Data("""
        {
          "sessions": [
            {
              "title": "Missing identity",
              "created_at": \(now - 60),
              "message_count": 4,
              "input_tokens": 10,
              "output_tokens": 20,
              "estimated_cost": 0.12
            },
            {
              "session_id": "   ",
              "title": "Blank identity",
              "created_at": \(now - 120),
              "message_count": 2,
              "input_tokens": 5,
              "output_tokens": 7,
              "estimated_cost": 0.03
            }
          ]
        }
        """.utf8))
        let client = StubInsightsClient(
            insightsResult: .failure(StubInsightsError()),
            sessionsResult: .success(response)
        )
        let viewModel = InsightsViewModel(client: client)
        viewModel.selectedTimeframe = .last7Days

        await viewModel.load()

        XCTAssertEqual(viewModel.sessionCount, 0)
        XCTAssertEqual(viewModel.totalMessages, 0)
        XCTAssertEqual(viewModel.totalTokens, 0)
        XCTAssertEqual(viewModel.estimatedCost, 0)
        XCTAssertEqual(client.sessionRequests, 0)
        XCTAssertFalse(viewModel.hasLoadedAnalytics)
        XCTAssertEqual(viewModel.errorMessage, "Server insights unavailable")
    }

    @MainActor
    func testLoadUsesServerInsightsWhenAvailable() async throws {
        let client = StubInsightsClient(
            insightsResult: .success(try decodeInsights("""
            {
              "period_days": 30,
              "total_sessions": 5,
              "total_messages": 13,
              "total_input_tokens": 100,
              "total_output_tokens": 250,
              "total_tokens": 350,
              "total_cost": 0.42,
              "total_cache_read_tokens": 80,
              "total_cache_hit_percent": 64.2
            }
            """)),
            sessionsResult: .failure(StubInsightsError())
        )
        let viewModel = InsightsViewModel(client: client)

        await viewModel.load()

        XCTAssertEqual(client.requestedDays, [30])
        XCTAssertTrue(viewModel.hasLoadedAnalytics)
        XCTAssertEqual(viewModel.periodDays, 30)
        XCTAssertEqual(viewModel.sessionCount, 5)
        XCTAssertEqual(viewModel.totalMessages, 13)
        XCTAssertEqual(viewModel.totalInputTokens, 100)
        XCTAssertEqual(viewModel.totalOutputTokens, 250)
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertEqual(viewModel.estimatedCost, 0.42, accuracy: 0.0001)
        XCTAssertEqual(viewModel.totalCacheReadTokens, 80)
        XCTAssertEqual(try XCTUnwrap(viewModel.totalCacheHitPercent), 64.2, accuracy: 0.0001)
    }

    @MainActor
    func testLoadKeepsExistingAnalyticsVisibleWhileTimeframeRefreshes() async throws {
        let client = DelayedInsightsClient(
            firstResponse: try decodeInsights("""
            {
              "period_days": 30,
              "total_sessions": 5,
              "total_tokens": 350
            }
            """)
        )
        let viewModel = InsightsViewModel(client: client)

        await viewModel.load()
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertEqual(viewModel.periodTitle, "Last 30 Days")

        viewModel.selectedTimeframe = .last7Days
        let refreshTask = Task { await viewModel.load() }
        await client.waitForPendingRequest()

        XCTAssertTrue(viewModel.isLoading)
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertEqual(viewModel.periodTitle, "Last 30 Days")

        client.completePendingRequest(with: .success(try decodeInsights("""
        {
          "period_days": 7,
          "total_sessions": 2,
          "total_tokens": 125
        }
        """)))
        await refreshTask.value

        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertEqual(viewModel.periodTitle, "Last 7 Days")
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testFailedRefreshPreservesTheServerSnapshot() async throws {
        let client = DelayedInsightsClient(firstResponse: try decodeInsights(
            #"{"period_days":30,"total_sessions":5,"total_tokens":350}"#
        ))
        let viewModel = InsightsViewModel(client: client)
        await viewModel.load()
        let refresh = Task { await viewModel.load() }
        await client.waitForPendingRequest()
        client.completePendingRequest(with: .failure(StubInsightsError()))
        await refresh.value
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertEqual(viewModel.sessionCount, 5)
        XCTAssertTrue(viewModel.hasLoadedAnalytics)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertEqual(viewModel.fallbackReason, "Server insights unavailable")
        XCTAssertTrue(viewModel.sourceDescription.contains("Server insights unavailable"))

        let retry = Task { await viewModel.load() }
        await client.waitForPendingRequest()
        client.completePendingRequest(with: .success(try decodeInsights(
            #"{"period_days":30,"total_sessions":2,"total_tokens":125}"#
        )))
        await retry.value
        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertFalse(viewModel.sourceDescription.contains("Server insights unavailable"))
    }

    // MARK: - Refresh retries (TAL-191)

    @MainActor
    func testCachedSnapshotStaysVisibleAndMarkedCachedWhileTheFirstRequestIsInFlight() async throws {
        let cache = try seededCache(tokens: 350)
        let client = ScriptedInsightsClient(results: [])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: RecordingSleeper().sleep)

        let load = Task { await viewModel.load() }
        await client.waitForPendingRequest()

        XCTAssertTrue(viewModel.isLoading)
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertTrue(viewModel.sourceDescription.contains("Showing cached server analytics"))

        client.completePendingRequest(with: .success(try insights(tokens: 125)))
        await load.value
        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertFalse(viewModel.sourceDescription.contains("cached"))
    }

    @MainActor
    func testTransientFailuresRetryOnTheDecidedScheduleAndPersistTheRecoveredSnapshot() async throws {
        let cache = try seededCache(tokens: 350)
        let sleeper = RecordingSleeper()
        let client = ScriptedInsightsClient(results: [
            .failure(APIError.http(statusCode: 503, body: nil)),
            .failure(APIError.network(underlying: URLError(.timedOut))),
            .failure(APIError.http(statusCode: 408, body: nil)),
            .success(try insights(tokens: 125)),
        ])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: sleeper.sleep)

        await viewModel.load()

        XCTAssertEqual(client.requestedDays, [30, 30, 30, 30])
        XCTAssertEqual(sleeper.delays, [.seconds(1), .seconds(2), .seconds(4)])
        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertEqual(cache.load(timeframe: .last30Days)?.totalTokens, 125)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.lastError)
        XCTAssertNil(viewModel.fallbackReason)
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testExhaustedTransientRetriesKeepTheCachedSnapshotWithAStaleExplanation() async throws {
        let cache = try seededCache(tokens: 350)
        let sleeper = RecordingSleeper()
        let client = ScriptedInsightsClient(results: [502, 504, 503, 502].map {
            .failure(APIError.http(statusCode: $0, body: nil))
        })
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: sleeper.sleep)

        await viewModel.load()

        XCTAssertEqual(client.requestedDays.count, 4)
        XCTAssertEqual(sleeper.delays, [.seconds(1), .seconds(2), .seconds(4)])
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertEqual(cache.load(timeframe: .last30Days)?.totalTokens, 350)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertTrue(viewModel.sourceDescription.contains("Showing cached server analytics. Refresh failed"))
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testExhaustedTransientRetriesWithoutASnapshotShowTheTerminalError() async throws {
        let sleeper = RecordingSleeper()
        let client = ScriptedInsightsClient(results: Array(
            repeating: .failure(APIError.network(underlying: URLError(.notConnectedToInternet))),
            count: 4
        ))
        let viewModel = InsightsViewModel(client: client, sleep: sleeper.sleep)

        await viewModel.load()

        XCTAssertEqual(client.requestedDays.count, 4)
        XCTAssertEqual(sleeper.delays, [.seconds(1), .seconds(2), .seconds(4)])
        XCTAssertFalse(viewModel.hasLoadedAnalytics)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testDefinitiveFailuresDoNotRetry() async throws {
        let definitive: [Error] = [
            APIError.unauthorized,
            APIError.invalidServerURL,
            APIError.http(statusCode: 400, body: nil),
            APIError.http(statusCode: 404, body: nil),
            APIError.decoding(underlying: StubInsightsError()),
            APIError.network(underlying: URLError(.badURL)),
            APIError.network(underlying: URLError(.cancelled)),
            StubInsightsError(),
        ]
        for error in definitive {
            let sleeper = RecordingSleeper()
            let client = ScriptedInsightsClient(results: [.failure(error)])
            let viewModel = InsightsViewModel(client: client, sleep: sleeper.sleep)

            await viewModel.load()

            XCTAssertEqual(client.requestedDays.count, 1, "\(error)")
            XCTAssertEqual(sleeper.delays, [], "\(error)")
            XCTAssertNotNil(viewModel.errorMessage, "\(error)")
        }

        let sleeper = RecordingSleeper()
        let client = ScriptedInsightsClient(results: [.failure(CancellationError())])
        let viewModel = InsightsViewModel(client: client, sleep: sleeper.sleep)
        await viewModel.load()
        XCTAssertEqual(client.requestedDays.count, 1)
        XCTAssertEqual(sleeper.delays, [])
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testCancellationDuringARetryWaitStopsFurtherAttempts() async throws {
        let cache = try seededCache(tokens: 350)
        let sleeper = RecordingSleeper(holds: true)
        let client = ScriptedInsightsClient(results: [
            .failure(APIError.http(statusCode: 503, body: nil)),
            .success(try insights(tokens: 125)),
        ])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: sleeper.sleep)

        let load = Task { await viewModel.load() }
        let isWaiting = await sleeper.waitForPendingSleep()
        XCTAssertTrue(isWaiting)
        load.cancel()
        await load.value

        XCTAssertEqual(client.requestedDays.count, 1)
        XCTAssertEqual(viewModel.totalTokens, 350)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testANewerTimeframeLoadKeepsAnOlderRetryFromCommitting() async throws {
        let cache = InsightsResponseCache(server: URL(string: "https://insights.test")!, defaults: try isolatedDefaults())
        let sleeper = RecordingSleeper(holds: true)
        let client = ScriptedInsightsClient(results: [
            .failure(APIError.http(statusCode: 503, body: nil)),
            .success(try insights(tokens: 125, days: 7)),
            .success(try insights(tokens: 999)),
        ])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: sleeper.sleep)

        let olderLoad = Task { await viewModel.load() }
        let isWaiting = await sleeper.waitForPendingSleep()
        XCTAssertTrue(isWaiting)

        viewModel.selectedTimeframe = .last7Days
        await viewModel.load()
        sleeper.releasePendingSleep()
        await olderLoad.value

        XCTAssertEqual(client.requestedDays, [30, 7])
        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertEqual(viewModel.periodTitle, "Last 7 Days")
        XCTAssertNil(cache.load(timeframe: .last30Days))
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testRefreshPersistsOnlyItsOwnServerAndTimeframe() async throws {
        let defaults = try isolatedDefaults()
        let server = URL(string: "https://insights.test")!
        let cache = InsightsResponseCache(server: server, defaults: defaults)
        let otherServer = InsightsResponseCache(server: URL(string: "https://other.test")!, defaults: defaults)
        cache.save(try insights(tokens: 7), timeframe: .last7Days)
        otherServer.save(try insights(tokens: 30), timeframe: .last30Days)
        let client = ScriptedInsightsClient(results: [.success(try insights(tokens: 125))])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: RecordingSleeper().sleep)

        await viewModel.load()

        XCTAssertEqual(cache.load(timeframe: .last30Days)?.totalTokens, 125)
        XCTAssertEqual(cache.load(timeframe: .last7Days)?.totalTokens, 7)
        XCTAssertEqual(otherServer.load(timeframe: .last30Days)?.totalTokens, 30)
    }

    private func insights(tokens: Int, days: Int = 30) throws -> InsightsResponse {
        try decodeInsights(#"{"period_days":\#(days),"total_sessions":1,"total_tokens":\#(tokens)}"#)
    }

    private func isolatedDefaults() throws -> UserDefaults {
        let suiteName = "InsightsViewModelTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
        return defaults
    }

    private func seededCache(tokens: Int) throws -> InsightsResponseCache {
        let cache = InsightsResponseCache(server: URL(string: "https://insights.test")!, defaults: try isolatedDefaults())
        cache.save(try insights(tokens: tokens), timeframe: .last30Days)
        return cache
    }

    private func decodeInsights(_ json: String) throws -> InsightsResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(InsightsResponse.self, from: Data(json.utf8))
    }

}

private final class StubInsightsClient: InsightsDataClient {
    private let insightsResult: Result<InsightsResponse, Error>
    private let sessionsResult: Result<SessionsResponse, Error>
    private(set) var requestedDays: [Int] = []
    private(set) var sessionRequests = 0

    init(insightsResult: Result<InsightsResponse, Error>, sessionsResult: Result<SessionsResponse, Error>) {
        self.insightsResult = insightsResult
        self.sessionsResult = sessionsResult
    }

    func insights(days: Int) async throws -> InsightsResponse {
        requestedDays.append(days)
        return try insightsResult.get()
    }

    func sessions() async throws -> SessionsResponse {
        sessionRequests += 1
        return try sessionsResult.get()
    }
}

private struct StubInsightsError: LocalizedError {
    var errorDescription: String? {
        "Server insights unavailable"
    }
}

@MainActor
private final class DelayedInsightsClient: InsightsDataClient {
    private var firstResponse: InsightsResponse?
    private var pendingContinuation: CheckedContinuation<InsightsResponse, Error>?

    init(firstResponse: InsightsResponse) {
        self.firstResponse = firstResponse
    }

    func insights(days: Int) async throws -> InsightsResponse {
        if let response = firstResponse {
            firstResponse = nil
            return response
        }

        return try await withCheckedThrowingContinuation { continuation in
            pendingContinuation = continuation
        }
    }

    func sessions() async throws -> SessionsResponse {
        throw StubInsightsError()
    }

    func waitForPendingRequest() async {
        while pendingContinuation == nil {
            await Task.yield()
        }
    }

    func completePendingRequest(with result: Result<InsightsResponse, Error>) {
        pendingContinuation?.resume(with: result)
        pendingContinuation = nil
    }
}

@MainActor
private final class ScriptedInsightsClient: InsightsDataClient {
    private var results: [Result<InsightsResponse, Error>]
    private var pendingContinuation: CheckedContinuation<InsightsResponse, Error>?
    private(set) var requestedDays: [Int] = []

    /// Answers each request with the next scripted result, then suspends until the test completes it.
    init(results: [Result<InsightsResponse, Error>]) {
        self.results = results
    }

    func insights(days: Int) async throws -> InsightsResponse {
        requestedDays.append(days)
        if !results.isEmpty {
            return try results.removeFirst().get()
        }
        return try await withCheckedThrowingContinuation { continuation in
            pendingContinuation = continuation
        }
    }

    func waitForPendingRequest() async {
        while pendingContinuation == nil {
            await Task.yield()
        }
    }

    func completePendingRequest(with result: Result<InsightsResponse, Error>) {
        pendingContinuation?.resume(with: result)
        pendingContinuation = nil
    }
}

/// Records retry delays without waiting on the wall clock; a holding sleeper suspends until released or cancelled.
@MainActor
private final class RecordingSleeper {
    private let holds: Bool
    private var pendingRelease: AsyncStream<Void>.Continuation?
    private(set) var delays: [Duration] = []

    init(holds: Bool = false) {
        self.holds = holds
    }

    func sleep(_ delay: Duration) async throws {
        delays.append(delay)
        guard holds else { return }
        let (release, continuation) = AsyncStream<Void>.makeStream()
        pendingRelease = continuation
        for await _ in release { return }
        throw CancellationError()
    }

    func waitForPendingSleep() async -> Bool {
        for _ in 0..<1_000 where pendingRelease == nil {
            await Task.yield()
        }
        return pendingRelease != nil
    }

    func releasePendingSleep() {
        pendingRelease?.yield()
        pendingRelease = nil
    }
}
