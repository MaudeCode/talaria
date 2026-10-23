import XCTest
@testable import TalariaKit

/// The screen slides aside for the sidebar, or the sidebar slides in over a screen that stays beside
/// its vertical bar (TAL-481).
final class AppSidebarSlideTests: XCTestCase {
    private let push = AppSidebarSlide(revealWidth: 300, leadingInset: 40, presentsOver: false)
    private let over = AppSidebarSlide(revealWidth: 300, leadingInset: 40, presentsOver: true)

    func testPushModeMovesOnlyTheScreen() {
        for (progress, offset) in [(0.0, 0.0), (0.5, 150.0), (1.0, 300.0)] as [(CGFloat, CGFloat)] {
            XCTAssertEqual(push.surfaceOffset(progress: progress), offset, "p = \(progress)")
            XCTAssertEqual(push.sidebarOffset(progress: progress), 0, "p = \(progress)")
            XCTAssertEqual(push.tintAlpha(progress: progress), progress, "p = \(progress)")
        }
    }

    func testOverModeMovesOnlyTheSidebar() {
        for (progress, offset) in [(0.0, -340.0), (0.5, -170.0), (1.0, 0.0)] as [(CGFloat, CGFloat)] {
            XCTAssertEqual(over.surfaceOffset(progress: progress), 0, "p = \(progress)")
            XCTAssertEqual(over.sidebarOffset(progress: progress), offset, "p = \(progress)")
            XCTAssertEqual(over.tintAlpha(progress: progress), progress, "p = \(progress)")
        }
    }

    func testOffsetMapsBackToProgress() {
        for progress in [0, 0.25, 0.5, 1] as [CGFloat] {
            let pushed = push.surfaceOffset(progress: progress)
            let presented = over.sidebarOffset(progress: progress)
            XCTAssertEqual(push.progress(movingOffset: pushed), progress, accuracy: 1e-9)
            XCTAssertEqual(over.progress(movingOffset: presented), progress, accuracy: 1e-9)
        }
        XCTAssertEqual(push.progress(movingOffset: 900), 1)
        XCTAssertEqual(over.progress(movingOffset: -900), 0)
        let empty = AppSidebarSlide(revealWidth: 0, leadingInset: 0, presentsOver: true)
        XCTAssertEqual(empty.progress(movingOffset: 10), 0)
    }
}
