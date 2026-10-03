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
