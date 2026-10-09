import XCTest
@testable import Talaria

final class ChatCodeBlockCopyConfirmationTests: XCTestCase {
    private typealias CopyConfirmation = ChatCodeBlock.CopyConfirmation
    private let start = ContinuousClock.now

    func testCopyShowsConfirmationUntilTwoSecondsPass() {
        var confirmation = CopyConfirmation()
        XCTAssertFalse(confirmation.isShowing)

        confirmation.copied(at: start)
        XCTAssertTrue(confirmation.isShowing)

        confirmation.expire(at: start + .milliseconds(1_999))
        XCTAssertTrue(confirmation.isShowing)

        confirmation.expire(at: start + .seconds(2))
        XCTAssertFalse(confirmation.isShowing, "unchanged code restores the Copy button after 2 seconds")
    }

    func testCopyAfterExpiryShowsFreshConfirmation() {
        var confirmation = CopyConfirmation()
        confirmation.copied(at: start)
        confirmation.expire(at: start + .seconds(2))

        confirmation.copied(at: start + .seconds(5))
        XCTAssertTrue(confirmation.isShowing)
        confirmation.expire(at: start + .milliseconds(6_999))
        XCTAssertTrue(confirmation.isShowing)
        confirmation.expire(at: start + .seconds(7))
        XCTAssertFalse(confirmation.isShowing)
    }

    func testRepeatedCopyRestartsIntervalAndOlderResetCannotClearIt() {
        var confirmation = CopyConfirmation()
        confirmation.copied(at: start)
        confirmation.copied(at: start + .milliseconds(1_500))

        // The first copy's reset fires at its own 2-second mark.
        confirmation.expire(at: start + .seconds(2))
        XCTAssertTrue(confirmation.isShowing, "an older reset must not clear newer feedback")

        confirmation.expire(at: start + .milliseconds(3_500))
        XCTAssertFalse(confirmation.isShowing)
    }

    func testResetClearsConfirmationImmediately() {
        var confirmation = CopyConfirmation()
        confirmation.copied(at: start)

        confirmation.reset()
        XCTAssertFalse(confirmation.isShowing)
        XCTAssertNil(confirmation.expiresAt)
    }
}
