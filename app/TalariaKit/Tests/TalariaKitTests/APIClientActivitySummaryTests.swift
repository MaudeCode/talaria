import XCTest
@testable import TalariaKit

/// TAL-2232: `APIClient.activitySummary` reads the server's running and waiting chats in the server's order.
final class APIClientActivitySummaryTests: APIClientTestCase {
    func testDecodesTheSharedFixtureInServerOrder() async throws {
        let fixture = String(decoding: try sharedContractFixture("activity-summary"), as: UTF8.self)
        let requested = LockedTestValue<URL?>(nil)
        let client = makeClient { request in
            requested.value = request.url
            return apiTestJSONResponse(fixture, for: request)
        }

        let summary = try await client.activitySummary(profile: "work")

        let url = try XCTUnwrap(requested.value)
        XCTAssertEqual(url.path, "/api/activity/summary")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "profile", value: "work")])
        XCTAssertEqual([summary.waitingCount, summary.runningCount], [2, 2])
        XCTAssertEqual(summary.rows.map(\.sessionId), ["approval", "input", "run_new", "run_old"])
        let approval = try XCTUnwrap(summary.rows.first)
        XCTAssertEqual(approval.phase, "waiting_for_approval")
        XCTAssertEqual(approval.approvalId, "appr-1")
        XCTAssertEqual(approval.deepLink, "/sessions/approval")
        XCTAssertEqual(approval.startedAt, 1_799_998_000)
        XCTAssertNil(summary.rows[1].approvalId)
    }
}
