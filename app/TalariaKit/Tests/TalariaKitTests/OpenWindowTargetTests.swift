import XCTest
@testable import TalariaKit

/// TAL-2389: a sidebar chat or section opens in its own window through one user activity.
final class OpenWindowTargetTests: XCTestCase {
    private func roundTrip(_ target: OpenWindowTarget) -> OpenWindowTarget? {
        OpenWindowTarget(activity: target.activity(title: "Window"))
    }

    func testTheActivityCarriesASessionAndEverySidebarSection() {
        XCTAssertEqual(roundTrip(.session("s-1")), .session("s-1"))
        for section: SessionListUtilityDestination in [.tasks, .kanban, .skills, .memory, .insights, .decisions] {
            XCTAssertEqual(roundTrip(.section(section)), .section(section), "\(section)")
        }
        let activity = OpenWindowTarget.session("s-1").activity(title: "Plan the trip")
        XCTAssertEqual(activity.activityType, "dev.kil.talaria.open-window")
        XCTAssertEqual(activity.title, "Plan the trip")
    }

    func testAnotherActivityOrAnUnknownPayloadOpensNothing() {
        XCTAssertNil(OpenWindowTarget(activity: NSUserActivity(activityType: "dev.kil.talaria.other")))
        XCTAssertNil(OpenWindowTarget(userInfo: ["section": "settings"]))
        XCTAssertNil(OpenWindowTarget(userInfo: ["session": ""]))
        XCTAssertNil(OpenWindowTarget(userInfo: nil))
    }

    func testTheMenuIsOfferedOnlyWhereSeveralWindowsShow() {
        XCTAssertEqual(OpenWindowTarget(section: .kanban, supportsMultipleWindows: true), .section(.kanban))
        XCTAssertNil(OpenWindowTarget(section: .kanban, supportsMultipleWindows: false), "a plain iPhone shows one window")
        XCTAssertNil(OpenWindowTarget(section: .archived, supportsMultipleWindows: true), "not a sidebar destination row")

        let other = SessionSummary(sessionId: "other")
        XCTAssertEqual(SessionNavigationState().newWindowTarget(for: other, supportsMultipleWindows: true), .session("other"))
        XCTAssertNil(SessionNavigationState().newWindowTarget(for: other, supportsMultipleWindows: false))
        XCTAssertNil(SessionNavigationState().newWindowTarget(for: SessionSummary(sessionId: nil), supportsMultipleWindows: true))
    }

    func testAChatThisWindowShowsNeedsNoNewWindow() {
        let primary = SessionSummary(sessionId: "primary")
        let secondary = SessionSummary(sessionId: "secondary")
        var navigation = SessionNavigationState()
        navigation.select(primary)
        navigation.openBeside(secondary)
        XCTAssertNil(navigation.newWindowTarget(for: primary, supportsMultipleWindows: true), "the chat it shows")
        XCTAssertNil(navigation.newWindowTarget(for: secondary, supportsMultipleWindows: true), "the chat open beside it")
    }
}
