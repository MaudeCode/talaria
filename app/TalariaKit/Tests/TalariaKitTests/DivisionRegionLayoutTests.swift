import CoreGraphics
import SwiftUI
import XCTest
@testable import TalariaKit

final class DivisionRegionLayoutTests: XCTestCase {
    private let bounds = CGRect(x: 0, y: 0, width: 900, height: 700)

    func testBookFoldKeepsComposerEntirelyBeyondDivision() {
        let fold = CGRect(x: 430, y: 0, width: 40, height: 700)
        let frame = DivisionRegionLayout.availableFrame(in: bounds, divisions: [fold], avoidsHorizontalDivisions: false)
        XCTAssertEqual(frame, CGRect(x: 470, y: 0, width: 430, height: 700))
        XCTAssertGreaterThanOrEqual(frame.minX, fold.maxX)
    }

    func testUnfoldedAndTabletopKeepFullWidth() {
        for divisions in [[], [CGRect(x: 450, y: 0, width: 0, height: 700)],
                          [CGRect(x: 0, y: 330, width: 900, height: 40)]] {
            XCTAssertEqual(DivisionRegionLayout.availableFrame(in: bounds, divisions: divisions,
                avoidsHorizontalDivisions: false), bounds)
        }
    }

    func testAlreadySeparatedPaneDoesNotShrinkAgain() {
        for fold in [CGRect(x: -40, y: 0, width: 40, height: 700),
                     CGRect(x: 900, y: 0, width: 40, height: 700)] {
            XCTAssertEqual(DivisionRegionLayout.availableFrame(in: bounds, divisions: [fold],
                avoidsHorizontalDivisions: false), bounds)
        }
    }

    /// TAL-1458: a split arrangement's pane ends at the fold, which may overlap its edge; the pane keeps its own side.
    func testAFoldAtAnEdgeOnlyTrimsThatEdge() {
        for direction in [LayoutDirection.leftToRight, .rightToLeft] {
            XCTAssertEqual(DivisionRegionLayout.availableFrame(in: bounds, divisions: [CGRect(x: 880, y: 0, width: 40, height: 700)],
                layoutDirection: direction, avoidsHorizontalDivisions: false), CGRect(x: 0, y: 0, width: 880, height: 700))
            XCTAssertEqual(DivisionRegionLayout.availableFrame(in: bounds, divisions: [CGRect(x: -20, y: 0, width: 40, height: 700)],
                layoutDirection: direction, avoidsHorizontalDivisions: false), CGRect(x: 20, y: 0, width: 880, height: 700))
        }
    }

    func testUsesContainerCoordinatesAndLastVerticalDivision() {
        let container = CGRect(x: 100, y: 50, width: 900, height: 700)
        let folds = [CGRect(x: 350, y: 0, width: 20, height: 800),
                     CGRect(x: 650, y: 0, width: 30, height: 800)]
        XCTAssertEqual(DivisionRegionLayout.availableFrame(in: container, divisions: folds,
            avoidsHorizontalDivisions: false),
                       CGRect(x: 680, y: 50, width: 320, height: 700))
    }

    func testRTLSelectsThePhysicalLeftPaneOfAnOffCenterFold() {
        let fold = CGRect(x: 300, y: 0, width: 40, height: 700)
        XCTAssertEqual(DivisionRegionLayout.availableFrame(in: bounds, divisions: [fold], layoutDirection: .rightToLeft),
                       CGRect(x: 0, y: 0, width: 300, height: 700))
    }

    func testApprovalSelectsTheTopTabletopPane() {
        let fold = CGRect(x: 0, y: 330, width: 900, height: 40)
        XCTAssertEqual(DivisionRegionLayout.availableFrame(in: bounds, divisions: [fold]),
                       CGRect(x: 0, y: 0, width: 900, height: 330))
    }

    func testSidebarUsesTheLeadingBookPaneAndIgnoresTabletopAndFlat() {
        let book = CGRect(x: 430, y: 0, width: 40, height: 700)
        XCTAssertEqual(DivisionRegionLayout.sidebarWidth(in: bounds, divisions: [book]), 430)
        XCTAssertEqual(DivisionRegionLayout.sidebarWidth(in: bounds,
            divisions: [CGRect(x: 300, y: 0, width: 40, height: 700)], layoutDirection: .rightToLeft), 560)
        for divisions in [[], [CGRect(x: 0, y: 330, width: 900, height: 40)],
                          [CGRect(x: 950, y: 0, width: 40, height: 700)]] {
            XCTAssertNil(DivisionRegionLayout.sidebarWidth(in: bounds, divisions: divisions))
        }
    }

    func testTabletopPartitionsContentAndTouchControlsIncludingContainerOffset() {
        let pane = CGRect(x: 480, y: 80, width: 420, height: 620)
        let fold = CGRect(x: 0, y: 330, width: 900, height: 40)
        let frames = DivisionRegionLayout.chatFrames(in: pane, divisions: [fold], keyboardIsVisible: false)
        XCTAssertEqual(frames.transcript, CGRect(x: 480, y: 80, width: 420, height: 250))
        XCTAssertEqual(frames.composer, CGRect(x: 480, y: 370, width: 420, height: 330))
        XCTAssertTrue(frames.isTabletop)
        XCTAssertEqual(DivisionRegionLayout.availableFrame(in: pane, divisions: [fold], horizontalPlacement: .bottom), frames.composer)

        let keyboard = DivisionRegionLayout.chatFrames(in: pane, divisions: [fold], keyboardIsVisible: true)
        XCTAssertEqual(keyboard.transcript, pane)
        XCTAssertEqual(keyboard.composer, pane)
        XCTAssertFalse(keyboard.isTabletop)
    }

    func testBookAndFlatKeepTheTranscriptFullWidthAndTheComposerInItsPane() {
        let book = CGRect(x: 430, y: 0, width: 40, height: 700)
        let frames = DivisionRegionLayout.chatFrames(in: bounds, divisions: [book], keyboardIsVisible: false)
        XCTAssertEqual(frames.transcript, bounds)
        XCTAssertEqual(frames.composer, CGRect(x: 470, y: 0, width: 430, height: 700))
        XCTAssertFalse(frames.isTabletop)
        let flat = DivisionRegionLayout.chatFrames(in: bounds, divisions: [], keyboardIsVisible: false)
        XCTAssertEqual(flat.transcript, bounds)
        XCTAssertEqual(flat.composer, bounds)
        XCTAssertFalse(flat.isTabletop)
    }
}
