import XCTest
@testable import TalariaKit

final class KanbanBoardToolbarLayoutTests: XCTestCase {
    func testCompactPortraitMovesSecondaryControlsIntoOverflow() throws {
        let layout = KanbanBoardToolbarLayout.resolve(containerWidth: 402, controlWidth: 44)

        XCTAssertTrue(layout.usesOverflowMenu)
        XCTAssertEqual(try XCTUnwrap(layout.boardNameWidth), 90, accuracy: 0.5)
    }

    func testSmallestCompactWidthStillLeavesAReadableName() throws {
        let layout = KanbanBoardToolbarLayout.resolve(containerWidth: 375, controlWidth: 44)

        XCTAssertTrue(layout.usesOverflowMenu)
        XCTAssertEqual(
            try XCTUnwrap(layout.boardNameWidth),
            KanbanBoardToolbarLayout.minimumBoardNameWidth
        )
    }

    func testWideBarKeepsFourTrailingControlsAndCapsTheName() throws {
        let layout = KanbanBoardToolbarLayout.resolve(containerWidth: 750, controlWidth: 44)

        XCTAssertFalse(layout.usesOverflowMenu)
        XCTAssertEqual(try XCTUnwrap(layout.boardNameWidth), 374, accuracy: 0.5)
    }

    func testRegularWidthCapsTheNameWellBelowTheBar() throws {
        let layout = KanbanBoardToolbarLayout.resolve(containerWidth: 1024, controlWidth: 44)

        XCTAssertFalse(layout.usesOverflowMenu)
        XCTAssertEqual(try XCTUnwrap(layout.boardNameWidth), 648, accuracy: 0.5)
    }

    func testAccessibilityControlWidthNeverCollapsesTheBoardName() throws {
        for controlWidth in [CGFloat(88), 135] {
            let layout = KanbanBoardToolbarLayout.resolve(containerWidth: 402, controlWidth: controlWidth)

            XCTAssertTrue(layout.usesOverflowMenu, "control width \(controlWidth)")
            XCTAssertEqual(
                try XCTUnwrap(layout.boardNameWidth),
                KanbanBoardToolbarLayout.minimumBoardNameWidth,
                "control width \(controlWidth)"
            )
        }
    }

    func testUnknownBarWidthLeavesTheBoardNameUncapped() {
        for layout in [
            KanbanBoardToolbarLayout.resolve(containerWidth: 0, controlWidth: 44),
            KanbanBoardToolbarLayout.resolve(containerWidth: 402, controlWidth: 0)
        ] {
            XCTAssertNil(layout.boardNameWidth)
            XCTAssertFalse(layout.usesOverflowMenu)
        }
    }
}
