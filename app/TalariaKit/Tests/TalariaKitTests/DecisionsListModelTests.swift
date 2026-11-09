import XCTest
@testable import TalariaKit

/// TAL-1966: the Decisions list against the shared `contracts/fixtures/decision-review.json`, and the review its push opens.
@MainActor
final class DecisionsListModelTests: XCTestCase {
    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> DecisionsListModel {
        let host = "decisions-list-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        return DecisionsListModel(client: APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config)))
    }

    func testTheListKeepsTheServersRowsInOrderAndKeepsThemWhenAReloadFails() async throws {
        let list = try DecisionReviewModelTests.fixture("list")
        let fails = LockedTestValue(false)
        let model = model { request in
            XCTAssertEqual(request.request.url?.path, "/api/decisions")
            if fails.value { request.complete(withJSON: #"{"error":"down"}"#, statusCode: 503) } else { request.complete(withJSON: list) }
        }
        await model.load()

        XCTAssertEqual(model.rows, [
            DecisionReviewRow(reviewId: "dr_0a1b2c3d", sessionId: "synthetic-session", sessionTitle: "Workspace setup", title: "Workspace defaults",
                              status: .open, progress: DecisionProgress(total: 3, answered: 2)),
            DecisionReviewRow(reviewId: "dr_0a1b2c3e", sessionId: "synthetic-session-2", sessionTitle: nil, title: "Retention choices",
                              status: .submitted, progress: DecisionProgress(total: 2, answered: 2)),
        ])
        XCTAssertNil(model.list?.empty)

        fails.value = true
        await model.load()
        XCTAssertEqual(model.rows.map(\.reviewId), ["dr_0a1b2c3d", "dr_0a1b2c3e"])
        XCTAssertNotNil(model.loadError)
    }

    func testAnEmptyListCarriesTheServersReason() async throws {
        let empty = try DecisionReviewModelTests.fixture("list_empty")
        let model = model { $0.complete(withJSON: empty) }
        await model.load()
        XCTAssertEqual(model.rows, [])
        XCTAssertEqual(model.list?.empty, .closed)
    }

    /// The payload relay/convex/lib/apnsPayload.ts `makeNotification` sends for a decision review alert opens the review
    /// on the server that published it, above the current root.
    func testADecisionReviewPushOpensTheReviewOnItsServer() throws {
        let push: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Decision review ready", "body": "Workspace defaults"], "interruption-level": "active"],
            "publisherId": "https://decisions.test", "sessionId": "synthetic-session", "deepLink": "/decisions/dr_0a1b2c3d",
        ]
        let url = try XCTUnwrap(SessionNotificationRefresh.sessionURL(userInfo: push))
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "synthetic-session")
        XCTAssertEqual(TalariaDeepLink.publisherID(from: url), "https://decisions.test")
        XCTAssertEqual(TalariaDeepLink.decisionReviewID(from: url), "dr_0a1b2c3d")
        // A run alert's own deep link opens the chat.
        var runAlert = push
        runAlert["deepLink"] = "/sessions/synthetic-session"
        XCTAssertNil(TalariaDeepLink.decisionReviewID(from: try XCTUnwrap(SessionNotificationRefresh.sessionURL(userInfo: runAlert))))

        var navigation = SessionNavigationState()
        navigation.select(.decisionReview("dr_0a1b2c3d"))
        XCTAssertEqual(navigation.selectedItem, .decisionReview(id: "dr_0a1b2c3d"))
    }
}
