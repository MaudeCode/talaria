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

        let served = try decodeInsights(#"{"models": [{"model": "m", "cost_share": 0, "token_share": 26, "display_share": 7}]}"#)
        XCTAssertEqual(served.models?.first?.displayShare, 7, "The server's display share outranks the client fallback")
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
            """))
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
        XCTAssertTrue(viewModel.sourceDescription?.contains("Server insights unavailable") == true)

        let retry = Task { await viewModel.load() }
        await client.waitForPendingRequest()
        client.completePendingRequest(with: .success(try decodeInsights(
            #"{"period_days":30,"total_sessions":2,"total_tokens":125}"#
        )))
        await retry.value
        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertNil(viewModel.sourceDescription)
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
        XCTAssertTrue(viewModel.sourceDescription?.contains("Showing cached server analytics") == true)

        client.completePendingRequest(with: .success(try insights(tokens: 125)))
        await load.value
        XCTAssertEqual(viewModel.totalTokens, 125)
        XCTAssertNil(viewModel.sourceDescription)
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
        XCTAssertEqual(cache.load(InsightsRequest(timeframe: .last30Days))?.totalTokens, 125)
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
        XCTAssertEqual(cache.load(InsightsRequest(timeframe: .last30Days))?.totalTokens, 350)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertTrue(viewModel.sourceDescription?.contains("Showing cached server analytics. Refresh failed") == true)
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
        XCTAssertNil(cache.load(InsightsRequest(timeframe: .last30Days)))
        XCTAssertFalse(viewModel.isLoading)
    }

    @MainActor
    func testRefreshPersistsOnlyItsOwnServerAndTimeframe() async throws {
        let defaults = try isolatedDefaults()
        let server = URL(string: "https://insights.test")!
        let cache = InsightsResponseCache(server: server, defaults: defaults)
        let otherServer = InsightsResponseCache(server: URL(string: "https://other.test")!, defaults: defaults)
        cache.save(try insights(tokens: 7), for: InsightsRequest(timeframe: .last7Days))
        otherServer.save(try insights(tokens: 30), for: InsightsRequest(timeframe: .last30Days))
        let client = ScriptedInsightsClient(results: [.success(try insights(tokens: 125))])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: RecordingSleeper().sleep)

        await viewModel.load()

        XCTAssertEqual(cache.load(InsightsRequest(timeframe: .last30Days))?.totalTokens, 125)
        XCTAssertEqual(cache.load(InsightsRequest(timeframe: .last7Days))?.totalTokens, 7)
        XCTAssertEqual(otherServer.load(InsightsRequest(timeframe: .last30Days))?.totalTokens, 30)
    }

    private func insights(tokens: Int, days: Int = 30) throws -> InsightsResponse {
        try decodeInsights(#"{"period_days":\#(days),"total_sessions":1,"total_tokens":\#(tokens)}"#)
    }

    private func isolatedDefaults() throws -> UserDefaults {
        let suiteName = "InsightsViewModelTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        addTeardownBlock { UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName) }
        return defaults
    }

    private func seededCache(tokens: Int) throws -> InsightsResponseCache {
        let cache = InsightsResponseCache(server: URL(string: "https://insights.test")!, defaults: try isolatedDefaults())
        cache.save(try insights(tokens: tokens), for: InsightsRequest(timeframe: .last30Days))
        return cache
    }

    private func decodeInsights(_ json: String) throws -> InsightsResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(InsightsResponse.self, from: Data(json.utf8))
    }

}

@MainActor
private final class StubInsightsClient: InsightsDataClient {
    private let insightsResult: Result<InsightsResponse, Error>
    private(set) var requestedDays: [Int] = []

    init(insightsResult: Result<InsightsResponse, Error>) {
        self.insightsResult = insightsResult
    }

    func insights(days: Int, start: String?, end: String?) async throws -> InsightsResponse {
        requestedDays.append(days)
        return try insightsResult.get()
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

    func insights(days: Int, start: String?, end: String?) async throws -> InsightsResponse {
        if let response = firstResponse {
            firstResponse = nil
            return response
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

/// The query one `/api/insights` request sent.
private struct SentInsightsQuery: Hashable {
    let days: Int
    var start: String?
    var end: String?
}

@MainActor
private final class ScriptedInsightsClient: InsightsDataClient {
    private var results: [Result<InsightsResponse, Error>]
    private var pending: [SentInsightsQuery: CheckedContinuation<InsightsResponse, Error>] = [:]
    private(set) var requests: [SentInsightsQuery] = []
    var requestedDays: [Int] { requests.map(\.days) }

    /// Answers each request with the next scripted result, then holds it until the test completes that query.
    init(results: [Result<InsightsResponse, Error>]) {
        self.results = results
    }

    func insights(days: Int, start: String?, end: String?) async throws -> InsightsResponse {
        let query = SentInsightsQuery(days: days, start: start, end: end)
        requests.append(query)
        if !results.isEmpty {
            return try results.removeFirst().get()
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending[query] = continuation
        }
    }

    func waitForPendingRequest(_ query: SentInsightsQuery? = nil) async {
        while query.map({ pending[$0] == nil }) ?? pending.isEmpty {
            await Task.yield()
        }
    }

    /// Completes the held request for `query`, or the only one held.
    func completePendingRequest(_ query: SentInsightsQuery? = nil, with result: Result<InsightsResponse, Error>) {
        guard let query = query ?? pending.keys.first else { return }
        pending.removeValue(forKey: query)?.resume(with: result)
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

extension InsightsViewModelTests {
    func testCostDisplayPreservesTinyAmountsAndRoundsCents() {
        for (identifier, expected) in [
            ("en_US", ["$0.46", "$0.37", "$0.0004", "$0.00"]),
            ("de_DE", ["0,46\u{00a0}$", "0,37\u{00a0}$", "0,0004\u{00a0}$", "0,00\u{00a0}$"]),
        ] {
            for (amount, text) in zip([0.455, 0.3705, 0.0004, 0], expected) {
                XCTAssertEqual(amount.formattedCost(locale: Locale(identifier: identifier)), text)
            }
        }
        XCTAssertEqual(0.455.formattedCost(precision: 4, locale: Locale(identifier: "en_US")), "$0.4550")
        XCTAssertEqual(0.00000012345.formattedCost(locale: Locale(identifier: "en_US")), "$0.0000001234")
    }

    func testCompactNumbersReadLikeStatTiles() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(insightsCompactNumber(0, locale: locale), "0")
        XCTAssertEqual(insightsCompactNumber(950, locale: locale), "950")
        XCTAssertEqual(insightsCompactNumber(48_200, locale: locale), "48.2K")
        XCTAssertEqual(insightsCompactNumber(1_234_567, locale: locale), "1.23M")
    }

    func testDailyTokenDayParsesTheServerBucketAsALocalDay() throws {
        let insights = try decodeInsights("""
        {"daily_tokens": [{"date": "2030-02-03", "input_tokens": 1}, {"date": "yesterday", "input_tokens": 1}]}
        """)
        let days = try XCTUnwrap(insights.dailyTokens)
        let components = Calendar.current.dateComponents([.year, .month, .day], from: try XCTUnwrap(days[0].day))
        XCTAssertEqual([components.year, components.month, components.day], [2030, 2, 3])
        XCTAssertNil(days[1].day)
        XCTAssertEqual(insightsDayText(try XCTUnwrap(days[0].day)), "2030-02-03", "A picked day goes back to the server as the same text")
    }
}

extension InsightsViewModelTests {
    private struct Account: Identifiable, Equatable { let id: String }

    func testQuotaOrderPutsSavedAccountsFirstAndKeepsServerOrderForTheRest() {
        let sources = ["a", "b", "c", "d"].map(Account.init)
        XCTAssertEqual(ProviderQuotaOrderSettings.ordered(sources, by: ["c", "zzz", "a"]).map(\.id), ["c", "a", "b", "d"])
        XCTAssertEqual(ProviderQuotaOrderSettings.ordered(sources, by: []).map(\.id), ["a", "b", "c", "d"])
        let moved = ProviderQuotaOrderSettings.moved(["c", "a", "b", "d"], fromOffsets: IndexSet(integer: 3), toOffset: 0, within: ["c", "hidden", "a"])
        XCTAssertEqual(moved, ["d", "c", "a", "b", "hidden"])
        XCTAssertEqual(ProviderQuotaOrderSettings.sourceIDs(from: ProviderQuotaOrderSettings.data(moved)), moved)
        XCTAssertEqual(ProviderQuotaOrderSettings.sourceIDs(from: Data()), [])
    }
}

// MARK: - Custom ranges (TAL-1118)

extension InsightsViewModelTests {
    @MainActor
    func testCustomRangeRequestsThePickedDaysAndNamesTheServedRange() async throws {
        let custom = try InsightsRangeFixture.load().custom
        let client = ScriptedInsightsClient(results: [.success(custom.response)])
        let viewModel = InsightsViewModel(client: client, sleep: RecordingSleeper().sleep)
        viewModel.customRange = InsightsCustomRange(start: custom.start, end: custom.end)
        viewModel.select(.custom)

        await viewModel.load()

        XCTAssertEqual(client.requests, [SentInsightsQuery(days: 30, start: custom.start, end: custom.end)])
        let year = try XCTUnwrap((custom.range["start_date"] as? String)?.prefix(4))
        XCTAssertTrue(viewModel.periodTitle.contains(year), viewModel.periodTitle)
        XCTAssertFalse(AnalyticsTimeframe.allCases.map(\.title).contains(viewModel.periodTitle))
        XCTAssertFalse(viewModel.periodTitle.contains("Days"), viewModel.periodTitle)
        XCTAssertEqual(viewModel.rangeTimezone, custom.range["timezone"] as? String)
        XCTAssertEqual(viewModel.rangeNotes, [])
    }

    @MainActor
    func testAFallbackNamesThePresetTheServerServedAndWhy() async throws {
        let fallback = try InsightsRangeFixture.load().fallback
        let client = ScriptedInsightsClient(results: [.success(fallback.response)])
        let viewModel = InsightsViewModel(client: client, sleep: RecordingSleeper().sleep)
        viewModel.customRange = InsightsCustomRange(start: fallback.start, end: fallback.end)
        viewModel.select(.custom)

        await viewModel.load()

        let days = try XCTUnwrap(fallback.response.periodDays)
        XCTAssertEqual(viewModel.periodTitle, "Last \(days) Days")
        XCTAssertNil(viewModel.rangeTimezone)
        XCTAssertEqual(viewModel.rangeNotes, ["Unreadable start date; showing \(days) days"])
    }

    @MainActor
    func testTheCustomDraftStartsFromTheRangeOnScreenAndOutlivesPresetSwitches() async throws {
        let served = try InsightsRangeFixture.load().fallback
        let viewModel = InsightsViewModel(
            client: ScriptedInsightsClient(results: [.success(served.response)]),
            sleep: RecordingSleeper().sleep
        )
        await viewModel.load()

        viewModel.select(.custom)
        let onScreen = InsightsCustomRange(
            start: try XCTUnwrap(served.range["start_date"] as? String),
            end: try XCTUnwrap(served.range["end_date"] as? String)
        )
        XCTAssertEqual(viewModel.request, InsightsRequest(timeframe: .custom, custom: onScreen))

        viewModel.customRange?.start = "2025-01-01"
        viewModel.select(.last7Days)
        XCTAssertEqual(viewModel.request, InsightsRequest(timeframe: .last7Days))
        viewModel.select(.custom)
        XCTAssertEqual(viewModel.customRange, InsightsCustomRange(start: "2025-01-01", end: onScreen.end))
    }

    @MainActor
    func testANewerRangeKeepsAnOlderRangesLateAnswerFromCommitting() async throws {
        let cache = InsightsResponseCache(server: URL(string: "https://insights.test")!, defaults: try isolatedDefaults())
        let client = ScriptedInsightsClient(results: [])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: RecordingSleeper().sleep)
        let older = InsightsCustomRange(start: "2026-03-01", end: "2026-03-03")
        let newer = InsightsCustomRange(start: "2026-03-01", end: "2026-03-10")
        viewModel.customRange = older
        viewModel.select(.custom)
        let olderLoad = Task { await viewModel.load() }
        let olderQuery = SentInsightsQuery(days: 30, start: older.start, end: older.end)
        await client.waitForPendingRequest(olderQuery)

        viewModel.customRange = newer
        let newerLoad = Task { await viewModel.load() }
        let newerQuery = SentInsightsQuery(days: 30, start: newer.start, end: newer.end)
        await client.waitForPendingRequest(newerQuery)
        client.completePendingRequest(newerQuery, with: .success(try insights(tokens: 200)))
        await newerLoad.value
        client.completePendingRequest(olderQuery, with: .success(try insights(tokens: 100)))
        await olderLoad.value

        XCTAssertEqual(viewModel.totalTokens, 200)
        XCTAssertEqual(cache.load(InsightsRequest(timeframe: .custom, custom: newer))?.totalTokens, 200)
        XCTAssertNil(cache.load(InsightsRequest(timeframe: .custom, custom: older)))
        XCTAssertFalse(viewModel.isLoading)
    }

    func testCustomRangesCacheApartFromPresetsAndOtherServers() throws {
        let defaults = try isolatedDefaults()
        // A preset entry as builds before custom ranges wrote it.
        defaults.set(Data(#"{"https://insights.test":{"last30Days":{"totalTokens":350}}}"#.utf8), forKey: InsightsResponseCache.storageKey)
        let cache = InsightsResponseCache(server: URL(string: "https://insights.test")!, defaults: defaults)
        let otherServer = InsightsResponseCache(server: URL(string: "https://other.test")!, defaults: defaults)
        let first = InsightsRequest(timeframe: .custom, custom: InsightsCustomRange(start: "2026-03-01", end: "2026-03-03"))
        let second = InsightsRequest(timeframe: .custom, custom: InsightsCustomRange(start: "2026-03-04", end: "2026-03-05"))

        cache.save(try insights(tokens: 1), for: first)
        cache.save(try insights(tokens: 2), for: second)

        XCTAssertEqual(cache.load(InsightsRequest(timeframe: .last30Days))?.totalTokens, 350)
        XCTAssertNil(cache.load(first), "One custom range per server: a new pick replaces the last")
        XCTAssertEqual(cache.load(second)?.totalTokens, 2)
        XCTAssertNil(otherServer.load(second))
    }

    @MainActor
    func testAFailedCustomRefreshKeepsShowingOnlyDataThatMatchesItsLabel() async throws {
        let custom = try InsightsRangeFixture.load().custom
        let cache = InsightsResponseCache(server: URL(string: "https://insights.test")!, defaults: try isolatedDefaults())
        let cached = InsightsRequest(timeframe: .custom, custom: InsightsCustomRange(start: custom.start, end: custom.end))
        cache.save(custom.response, for: cached)
        let client = ScriptedInsightsClient(results: [
            .failure(APIError.http(statusCode: 400, body: nil)),
            .failure(APIError.http(statusCode: 400, body: nil)),
        ])
        let viewModel = InsightsViewModel(client: client, cache: cache, sleep: RecordingSleeper().sleep)
        viewModel.customRange = cached.custom
        viewModel.select(.custom)

        await viewModel.load()

        XCTAssertEqual(viewModel.totalTokens, custom.response.totalTokens)
        XCTAssertTrue(viewModel.sourceDescription?.contains("Refresh failed") == true)
        let cachedTitle = viewModel.periodTitle

        viewModel.customRange = InsightsCustomRange(start: "2026-01-01", end: "2026-01-31")
        await viewModel.load()

        XCTAssertEqual(viewModel.totalTokens, custom.response.totalTokens)
        XCTAssertEqual(viewModel.periodTitle, cachedTitle, "Retained data keeps the label of the range it covers")
        XCTAssertNil(viewModel.errorMessage)
    }
}
