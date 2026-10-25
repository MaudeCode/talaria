import XCTest
@testable import TalariaKit

final class SidebarPresentationTests: XCTestCase {
    func testPresentationMatrixUsesOneColumnOrDrawer() {
        for regular in [false, true] {
            for size in [CGSize(width: 466, height: 678), CGSize(width: 669, height: 951),
                         CGSize(width: 899, height: 669), CGSize(width: 900, height: 669),
                         CGSize(width: 1024, height: 1366), CGSize(width: 1366, height: 1024)] {
                for stored in [false, true] {
                    for verticalBar in [false, true] {
                        let decision = SidebarPresentation(isRegularWidth: regular, splitSize: size,
                            hasVerticalBar: verticalBar, storedChoice: stored)
                        let tiles = regular && size.width > size.height && size.width >= 900
                        XCTAssertEqual(decision.tiled, tiles, "\(size), regular=\(regular)")
                        XCTAssertEqual(decision.showsColumn, tiles && stored)
                        XCTAssertEqual(decision.drawerEnabled, !tiles)
                        XCTAssertEqual(decision.toggleTarget, tiles ? .column : .drawer)
                        XCTAssertEqual(decision.hostsSidebarActionsInDetail, tiles && verticalBar)
                        XCTAssertFalse(decision.showsColumn && decision.drawerEnabled)
                    }
                }
            }
        }
    }

    func testBookForcesTheColumnWithoutChangingTheStoredChoice() {
        let size = CGSize(width: 951, height: 669)
        let open = SidebarPresentation(isRegularWidth: true, splitSize: size, hasVerticalBar: true, storedChoice: false)
        let book = SidebarPresentation(isRegularWidth: true, splitSize: size, hasVerticalBar: true,
            storedChoice: false, hasVerticalDivision: true)
        XCTAssertFalse(open.showsColumn)
        XCTAssertTrue(book.columnIsForced)
        XCTAssertTrue(book.showsColumn)
        XCTAssertFalse(book.drawerEnabled)
        XCTAssertEqual(open, SidebarPresentation(isRegularWidth: true, splitSize: size, hasVerticalBar: true, storedChoice: false))
    }

    func testLeavingTiledModeCollapsesEvenALateNativeColumnReport() {
        let portrait = SidebarPresentation(isRegularWidth: true, splitSize: CGSize(width: 669, height: 951),
            hasVerticalBar: false, storedChoice: true, columnIsVisible: true)
        XCTAssertFalse(portrait.showsColumn)
        XCTAssertTrue(portrait.requiresColumnCollapse(previouslyTiled: true, nativeColumnIsVisible: true))
        XCTAssertTrue(portrait.requiresColumnCollapse(previouslyTiled: false, nativeColumnIsVisible: true))
        XCTAssertFalse(portrait.drawerEnabled, "The drawer cannot open until the stale native column collapses")
        let settled = SidebarPresentation(isRegularWidth: true, splitSize: CGSize(width: 669, height: 951),
            hasVerticalBar: false, storedChoice: true)
        XCTAssertTrue(settled.drawerEnabled)
        XCTAssertFalse(settled.showsColumn)
        XCTAssertFalse(settled.hostsSidebarActionsInDetail)
    }

    func testFilesRotationDismissalConsumesItsWidthReservation() {
        let landscape = CGSize(width: 951, height: 669)
        let opened = SidebarPresentation(isRegularWidth: true, splitSize: landscape,
            hasVerticalBar: true, storedChoice: true, filesInspectorPresented: true,
            filesInspectorOpeningIsLandscape: true)
        XCTAssertTrue(opened.showsFilesInspector)
        XCTAssertFalse(opened.showsColumn)
        let rotated = SidebarPresentation(isRegularWidth: true, splitSize: CGSize(width: 669, height: 951),
            hasVerticalBar: false, storedChoice: true, filesInspectorPresented: true,
            filesInspectorOpeningIsLandscape: true)
        XCTAssertTrue(rotated.dismissesFilesInspector)
        XCTAssertFalse(rotated.showsFilesInspector)
        XCTAssertFalse(rotated.showsColumn)
        let returned = SidebarPresentation(isRegularWidth: true, splitSize: landscape,
            hasVerticalBar: true, storedChoice: true, filesInspectorPresented: false)
        XCTAssertFalse(returned.showsFilesInspector)
        XCTAssertTrue(returned.showsColumn)
    }

    func testFoldDismissesFilesAndUnfoldDoesNotRestoreIt() {
        for regular in [false, true] {
            let hidden = SidebarPresentation(isRegularWidth: regular, splitSize: CGSize(width: 669, height: 951),
                hasVerticalBar: false, storedChoice: false, hasVerticalDivision: regular,
                filesInspectorPresented: true)
            XCTAssertTrue(hidden.dismissesFilesInspector)
            XCTAssertFalse(hidden.showsFilesInspector)
        }
        let unfolded = SidebarPresentation(isRegularWidth: true, splitSize: CGSize(width: 951, height: 669),
            hasVerticalBar: true, storedChoice: false)
        XCTAssertFalse(unfolded.showsFilesInspector)
    }

    func testDrawerIntentMustBeConsumedBeforeAdmittingTheTiledColumn() {
        let size = CGSize(width: 951, height: 669)
        let stale = SidebarPresentation(isRegularWidth: true, splitSize: size,
            hasVerticalBar: true, storedChoice: true, drawerIsPresented: true)
        XCTAssertFalse(stale.showsColumn)
        XCTAssertFalse(stale.drawerEnabled)
        let reconciled = SidebarPresentation(isRegularWidth: true, splitSize: size,
            hasVerticalBar: true, storedChoice: true, drawerIsPresented: false)
        XCTAssertTrue(reconciled.showsColumn)
    }
}
