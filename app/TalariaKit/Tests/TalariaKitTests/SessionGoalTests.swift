import XCTest
@testable import TalariaKit

/// TAL-833: the standing `/goal` the server ships as the session `goal`, and the chip worded from it.
final class SessionGoalTests: APIClientTestCase {
    func testSharedFixtureDecodesEveryStatusAndNull() throws {
        let fixture = try Self.goalSessionFixture()
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: fixture))
        XCTAssertEqual(session.goal, SessionGoal(text: "Ship the release notes", status: .active, turnsUsed: 3, maxTurns: 20))

        let events = try XCTUnwrap(fixture["events"] as? [[String: Any]])
        let goals = try events.map { event in
            let data = try XCTUnwrap(event["data"] as? [String: Any])
            return try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: data)).goal
        }
        XCTAssertEqual(goals, [
            SessionGoal(text: "Ship the release notes", status: .active, turnsUsed: 4, maxTurns: 20),
            SessionGoal(text: "Ship the release notes", status: .parked, turnsUsed: 5, maxTurns: 20, reason: "CI running", parkedUntil: 1_770_000_600),
            SessionGoal(text: "Ship the release notes", status: .parked, turnsUsed: 5, maxTurns: 20, reason: "pid 4242"),
            SessionGoal(text: "Ship the release notes", status: .paused, turnsUsed: 5, maxTurns: 20, reason: "turn budget exhausted"),
            nil
        ])
    }

    func testAnAbsentUnknownOrIncompleteGoalDecodesAsNone() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        for json in [
            #"{"session_id": "s"}"#,
            #"{"session_id": "s", "goal": {"text": "x", "status": "someday", "turns_used": 1, "max_turns": 2}}"#,
            #"{"session_id": "s", "goal": {"text": "x", "status": "active", "max_turns": 2}}"#,
            #"{"session_id": "s", "goal": {"text": "x", "status": "active", "turns_used": "many", "max_turns": 2}}"#,
            #"{"session_id": "s", "goal": {"text": "x", "status": "active", "turns_used": 1}}"#,
            #"{"session_id": "s", "goal": {"status": "active", "turns_used": 1, "max_turns": 2}}"#
        ] {
            XCTAssertNil(try decoder.decode(SessionDetail.self, from: Data(json.utf8)).goal, json)
        }
    }

    func testChipWordsEachStatusAndHidesWithoutAGoal() {
        let now = Date(timeIntervalSince1970: 1_770_000_000)
        let sameDay = now.addingTimeInterval(600)
        let laterDay = now.addingTimeInterval(3 * 86_400)
        func label(_ goal: SessionGoal?) -> String? {
            SessionGoalChipPresentation(goal: goal, now: now)?.label
        }

        XCTAssertNil(SessionGoalChipPresentation(goal: nil, now: now))
        XCTAssertEqual(
            label(SessionGoal(text: "Ship the release notes", status: .active, turnsUsed: 3, maxTurns: 20)),
            "Goal · 3/20 turns · Ship the release notes"
        )
        XCTAssertEqual(
            label(SessionGoal(text: "Ship the release notes", status: .paused, turnsUsed: 5, maxTurns: 20, reason: "turn budget exhausted")),
            "Goal paused · 5/20 turns · turn budget exhausted · Ship the release notes"
        )
        XCTAssertEqual(
            label(SessionGoal(text: "Ship the release notes", status: .parked, turnsUsed: 5, maxTurns: 20, reason: "pid 4242")),
            "Goal parked · 5/20 turns · pid 4242 · Ship the release notes"
        )
        XCTAssertEqual(
            label(SessionGoal(text: "Ship", status: .parked, turnsUsed: 5, maxTurns: 20, reason: "CI running", parkedUntil: sameDay.timeIntervalSince1970)),
            "Goal parked · 5/20 turns · until \(sameDay.formatted(date: .omitted, time: .shortened)) · CI running · Ship"
        )
        XCTAssertEqual(
            label(SessionGoal(text: "Ship", status: .parked, turnsUsed: 5, maxTurns: 20, parkedUntil: laterDay.timeIntervalSince1970)),
            "Goal parked · 5/20 turns · until \(laterDay.formatted(date: .abbreviated, time: .shortened)) · Ship"
        )
    }

    @MainActor
    func testEachSessionLoadReplacesTheGoal() async throws {
        var goal = #""goal": {"text": "Ship", "status": "active", "turns_used": 1, "max_turns": 20, "reason": null, "parked_until": null}"#
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            apiTestJSONResponse(#"{"session": {"session_id": "session-abc", "messages": [], \#(goal)}}"#, for: request)
        }

        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.sessionGoal, SessionGoal(text: "Ship", status: .active, turnsUsed: 1, maxTurns: 20))

        goal = #""goal": null"#
        await viewModel.loadMessages()
        XCTAssertNil(viewModel.sessionGoal)
    }

    /// `goal_session` from the shared contract fixture.
    private static func goalSessionFixture() throws -> [String: Any] {
        // app/TalariaKit/Tests/TalariaKitTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/web-session.json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(fixture["goal_session"] as? [String: Any])
    }
}
