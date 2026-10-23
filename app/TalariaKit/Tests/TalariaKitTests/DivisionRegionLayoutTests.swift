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
}
