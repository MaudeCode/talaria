import XCTest
@testable import TalariaKit

final class APIClientInsightsTests: APIClientTestCase {
    func testInsightsRequestBuildsDaysQueryAndDecodesServerAnalytics() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/insights")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["days"], "30")

            return apiTestJSONResponse("""
            {
              "period_days": 30,
              "total_sessions": 3,
              "total_messages": 12,
              "total_input_tokens": 1200,
              "total_output_tokens": 450,
              "total_tokens": 1650,
              "total_cost": 0.0323,
              "total_cache_read_tokens": 900,
              "total_cache_hit_percent": 87.5,
              "models": [
                {
                  "model": "gpt-5.5",
                  "sessions": 3,
                  "input_tokens": 1200,
                  "output_tokens": 450,
                  "total_tokens": 1650,
                  "cost": 0.0323,
                  "cache_hit_percent": 87.5,
                  "cache_read_tokens": 900,
                  "session_share": 100,
                  "token_share": 100,
                  "cost_share": 100
                }
              ],
              "daily_tokens": [
                {
                  "date": "2026-05-21",
                  "input_tokens": 1200,
                  "output_tokens": 450,
                  "sessions": 3,
                  "cost": 0.0323
                }
              ],
              "activity_by_day": [
                { "day": "Thu", "sessions": 3 }
              ],
              "activity_by_hour": [
                { "hour": 14, "sessions": 3 }
              ]
            }
            """, for: request)
        }

        let response = try await client.insights(days: 30)

        XCTAssertEqual(response.periodDays, 30)
        XCTAssertEqual(response.totalSessions, 3)
        XCTAssertEqual(response.totalMessages, 12)
        XCTAssertEqual(response.totalInputTokens, 1_200)
        XCTAssertEqual(response.totalOutputTokens, 450)
        XCTAssertEqual(response.totalTokens, 1_650)
        XCTAssertEqual(try XCTUnwrap(response.totalCost), 0.0323, accuracy: 0.0001)
        XCTAssertEqual(response.totalCacheReadTokens, 900)
        XCTAssertEqual(try XCTUnwrap(response.totalCacheHitPercent), 87.5, accuracy: 0.0001)
        XCTAssertEqual(response.models?.first?.model, "gpt-5.5")
        XCTAssertEqual(try XCTUnwrap(response.models?.first?.cacheHitPercent), 87.5, accuracy: 0.0001)
        XCTAssertEqual(response.models?.first?.costShare, 100)
        XCTAssertEqual(response.dailyTokens?.first?.date, "2026-05-21")
        XCTAssertEqual(response.activityByDay?.first?.day, "Thu")
        XCTAssertEqual(response.activityByHour?.first?.hour, 14)
    }

    /// TAL-1118: the App sends a custom range's days as picked and decodes the range the server says it served.
    func testInsightsSendsACustomRangeAndDecodesTheServedRange() async throws {
        let fixture = try InsightsRangeFixture.load()
        for example in [fixture.custom, fixture.fallback] {
            let client = makeClient { request in
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                XCTAssertEqual(query, ["days": "30", "start": example.start, "end": example.end])
                return (HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)!, example.body)
            }

            let response = try await client.insights(days: 30, start: example.start, end: example.end)
            let range = try XCTUnwrap(response.range)

            XCTAssertEqual(range.mode, example.range["mode"] as? String)
            XCTAssertEqual(range.startDate, example.range["start_date"] as? String)
            XCTAssertEqual(range.endDate, example.range["end_date"] as? String)
            XCTAssertEqual(range.today, example.range["today"] as? String)
            XCTAssertEqual(range.timezone, example.range["timezone"] as? String)
            XCTAssertEqual(range.bucket, example.range["bucket"] as? String)
            XCTAssertEqual(range.fallbackReason, example.range["fallback_reason"] as? String)
            XCTAssertEqual(range.adjustments, example.range["adjustments"] as? [String])
        }
    }

    func testInsightsResponseToleratesMissingArraysAndLossyCounts() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let response = try decoder.decode(
            InsightsResponse.self,
            from: Data("""
            {
              "period_days": "30",
              "range": "not an object",
              "total_sessions": "4",
              "total_cost": "$1.25",
              "models": "not an array",
              "daily_tokens": null,
              "activity_by_day": { "unexpected": true }
            }
            """.utf8)
        )

        XCTAssertEqual(response.periodDays, 30)
        XCTAssertNil(response.range)
        XCTAssertEqual(response.totalSessions, 4)
        XCTAssertEqual(try XCTUnwrap(response.totalCost), 1.25, accuracy: 0.0001)
        XCTAssertNil(response.totalCacheReadTokens)
        XCTAssertNil(response.totalCacheHitPercent)
        XCTAssertNil(response.models)
        XCTAssertNil(response.dailyTokens)
        XCTAssertNil(response.activityByDay)
        XCTAssertNil(response.activityByHour)
    }

    func testInsightsResponseDecodesLossyCacheEfficiencyFields() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let response = try decoder.decode(
            InsightsResponse.self,
            from: Data("""
            {
              "total_cache_read_tokens": "900",
              "total_cache_hit_percent": "87.5",
              "models": [
                { "model": "gpt-5.5", "cache_hit_percent": 12 }
              ]
            }
            """.utf8)
        )

        XCTAssertEqual(response.totalCacheReadTokens, 900)
        XCTAssertEqual(try XCTUnwrap(response.totalCacheHitPercent), 87.5, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(response.models?.first?.cacheHitPercent), 12, accuracy: 0.0001)
    }

    func testInsightsFormattedPercentUsesAtMostOneFractionDigit() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(insightsFormattedPercent(87.5, locale: locale), "87.5%")
        XCTAssertEqual(insightsFormattedPercent(12, locale: locale), "12%")
        XCTAssertEqual(insightsFormattedPercent(0.19, locale: locale), "0.2%")
    }

    func testFormatTokensUsesLocaleGrouping() {
        let english = Locale(identifier: "en_US")
        XCTAssertEqual(formatTokens(0, locale: english), "0")
        XCTAssertEqual(formatTokens(42, locale: english), "42")
        XCTAssertEqual(formatTokens(1_234, locale: english), "1,234")
        XCTAssertEqual(formatTokens(9_876_543_210, locale: english), "9,876,543,210")

        let german = Locale(identifier: "de_DE")
        XCTAssertEqual(formatTokens(1_234, locale: german), "1.234")
        XCTAssertEqual(formatTokens(9_876_543_210, locale: german), "9.876.543.210")
    }
}

/// `contracts/fixtures/insights-range.json`: the server's own custom and fallback responses (TAL-1117).
struct InsightsRangeFixture {
    struct Example {
        let start: String
        let end: String
        /// The response body exactly as the server sent it.
        let body: Data
        let response: InsightsResponse
        let range: [String: Any]
    }

    let custom: Example
    let fallback: Example

    static func load() throws -> InsightsRangeFixture {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/insights-range.json"))
        let fixture = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func example(_ name: String) throws -> Example {
            let entry = try XCTUnwrap(fixture[name] as? [String: Any])
            let query = try XCTUnwrap(entry["query"] as? [String: String])
            let body = try XCTUnwrap(entry["body"] as? [String: Any])
            let bodyData = try JSONSerialization.data(withJSONObject: body)
            return Example(
                start: try XCTUnwrap(query["start"]),
                end: try XCTUnwrap(query["end"]),
                body: bodyData,
                response: try decoder.decode(InsightsResponse.self, from: bodyData),
                range: try XCTUnwrap(body["range"] as? [String: Any])
            )
        }
        return InsightsRangeFixture(custom: try example("custom"), fallback: try example("fallback"))
    }
}
