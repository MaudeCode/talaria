import Foundation
import TalariaKit
import XCTest

final class DelayedStatusVisibilityTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_770_000_000)

    private func at(_ seconds: TimeInterval) -> Date {
        start.addingTimeInterval(seconds)
    }

    func testStatusShorterThanTheShowDelayNeverAppears() {
        var status = DelayedStatusVisibility()

        status.update(isActive: true, now: at(0))
        XCTAssertFalse(status.isVisible)
        XCTAssertEqual(status.nextDeadline, at(0.4))

        status.update(isActive: false, now: at(0.39))
        XCTAssertFalse(status.isVisible)
        XCTAssertNil(status.nextDeadline)
    }

    func testStatusAppearsOnceItHasHeldForTheShowDelay() {
        var status = DelayedStatusVisibility()

        status.update(isActive: true, now: at(0))
        status.update(isActive: true, now: at(0.4))

        XCTAssertTrue(status.isVisible)
        XCTAssertNil(status.nextDeadline, "A visible, still-active status waits for the condition to end.")
    }

    func testVisibleStatusHoldsForTheMinimumDurationAfterTheConditionEnds() {
        var status = DelayedStatusVisibility()
        status.update(isActive: true, now: at(0))
        status.update(isActive: true, now: at(0.4))

        status.update(isActive: false, now: at(0.5))
        XCTAssertTrue(status.isVisible)
        XCTAssertEqual(status.nextDeadline, at(0.8))

        status.update(isActive: false, now: at(0.8))
        XCTAssertFalse(status.isVisible)
        XCTAssertNil(status.nextDeadline)
    }

    func testStatusVisibleLongerThanTheMinimumHidesAsSoonAsTheConditionEnds() {
        var status = DelayedStatusVisibility()
        status.update(isActive: true, now: at(0))
        status.update(isActive: true, now: at(0.4))

        status.update(isActive: false, now: at(2))

        XCTAssertFalse(status.isVisible)
    }

    func testInterruptedConditionRestartsTheShowDelay() {
        var status = DelayedStatusVisibility()
        status.update(isActive: true, now: at(0))
        status.update(isActive: false, now: at(0.3))
        status.update(isActive: true, now: at(0.35))

        status.update(isActive: true, now: at(0.5))
        XCTAssertFalse(status.isVisible, "The show delay counts continuous activity only.")
        XCTAssertEqual(status.nextDeadline, at(0.75))

        status.update(isActive: true, now: at(0.75))
        XCTAssertTrue(status.isVisible)
    }

    func testReactivationDuringTheHoldKeepsTheStatusVisible() {
        var status = DelayedStatusVisibility()
        status.update(isActive: true, now: at(0))
        status.update(isActive: true, now: at(0.4))
        status.update(isActive: false, now: at(0.5))

        status.update(isActive: true, now: at(0.6))
        status.update(isActive: true, now: at(1))

        XCTAssertTrue(status.isVisible)
        XCTAssertNil(status.nextDeadline)
    }
}
