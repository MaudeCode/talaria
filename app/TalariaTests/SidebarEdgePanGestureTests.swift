import UIKit
import SwiftUI
import XCTest
@testable import Talaria

/// The sidebar's edge pan yields to any on-screen stack that can go back and to a sheet,
/// however deep the stack sits in the controller tree (TAL-462), and wins over a list row's
/// swipe actions that start at the same edge (TAL-490).
@MainActor
final class SidebarEdgePanArbiterTests: XCTestCase {
    private var window: UIWindow!

    override func setUp() {
        super.setUp()
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    }

    override func tearDown() {
        window.isHidden = true
        window = nil
        super.tearDown()
    }

    func testOnlyAPushedOnScreenStackOwnsTheEdgeSwipe() {
        // A container holding a stack, as a split view holds its detail column.
        let root = UIViewController()
        let column = UIViewController()
        let navigation = UINavigationController(rootViewController: UIViewController())
        embed(column, in: root)
        embed(navigation, in: column)
        window.rootViewController = root
        window.makeKeyAndVisible()

        XCTAssertFalse(SidebarEdgePanArbiter.visibleStackOwnsEdgeSwipe(in: window))

        navigation.pushViewController(UIViewController(), animated: false)
        XCTAssertTrue(SidebarEdgePanArbiter.visibleStackOwnsEdgeSwipe(in: window))

        navigation.view.removeFromSuperview()
        XCTAssertFalse(
            SidebarEdgePanArbiter.visibleStackOwnsEdgeSwipe(in: window),
            "A stack that is not on screen must not block the sidebar"
        )
    }

    func testASheetOwnsTheEdgeSwipe() {
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        XCTAssertFalse(SidebarEdgePanArbiter.visibleStackOwnsEdgeSwipe(in: window))

        root.present(UIViewController(), animated: false)
        XCTAssertTrue(SidebarEdgePanArbiter.visibleStackOwnsEdgeSwipe(in: window))
    }

    func testARowSwipeStartingAtTheEdgeWaitsForTheSidebarPan() throws {
        let navigation = UINavigationController(rootViewController: UIViewController())
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        let list = UICollectionView(
            frame: window.bounds,
            collectionViewLayout: UICollectionViewCompositionalLayout.list(using: .init(appearance: .insetGrouped))
        )
        navigation.topViewController?.view.addSubview(list)
        let rowSwipe = UIPanGestureRecognizer()
        list.addGestureRecognizer(rowSwipe)
        let edgePan = UIScreenEdgePanGestureRecognizer()
        window.addGestureRecognizer(edgePan)
        let arbiter: UIGestureRecognizerDelegate = SidebarEdgePanArbiter()

        func waitsForEdgePan(_ other: UIGestureRecognizer) -> Bool {
            arbiter.gestureRecognizer?(edgePan, shouldBeRequiredToFailBy: other) ?? false
        }
        XCTAssertTrue(waitsForEdgePan(rowSwipe), "A row's swipe actions must not take the sidebar's edge pan")
        XCTAssertFalse(waitsForEdgePan(list.panGestureRecognizer), "Scrolling must not wait for the sidebar")
        // The edge pan already waits for the stack's back gestures; the reverse would deadlock.
        XCTAssertFalse(waitsForEdgePan(try XCTUnwrap(navigation.interactivePopGestureRecognizer)))
        if #available(iOS 26.0, *) {
            XCTAssertFalse(waitsForEdgePan(try XCTUnwrap(navigation.interactiveContentPopGestureRecognizer)))
        }
    }

    private func embed(_ child: UIViewController, in parent: UIViewController) {
        parent.addChild(child)
        parent.view.addSubview(child.view)
        child.didMove(toParent: parent)
    }
}

/// The sidebar container slides the screen with a transform, which UIKit counts against safe
/// areas; neither host may lose an inset and lay itself out again on open or close (TAL-477).
@MainActor
final class AppSidebarSafeAreaTests: XCTestCase {
    func testOpeningKeepsBothHostsSafeAreas() throws {
        let presentation = AppSidebarPresentation()
        let (window, controller) = try makeSidebarController(presentation)
        defer { window.isHidden = true }
        // A leading inset like a landscape iPhone's notch.
        controller.additionalSafeAreaInsets = UIEdgeInsets(top: 20, left: 50, bottom: 10, right: 30)
        controller.view.layoutIfNeeded()
        let hosts = controller.children.map(\.view!)
        let closed = hosts.map(\.safeAreaInsets)

        presentation.isPresented = true
        controller.view.layoutIfNeeded()
        hosts.forEach { $0.layoutIfNeeded() }

        XCTAssertEqual(hosts.map(\.safeAreaInsets), closed, "Opening the sidebar changed a host's safe area")
    }
}

/// The screen slides aside for the sidebar, except beside a vertical bar: the bar is window chrome
/// and stays put, so there the sidebar slides in over a screen that does not move (TAL-481).
@MainActor
final class AppSidebarPresentationTests: XCTestCase {
    func testPushModeSlidesTheScreen() throws {
        let presentation = AppSidebarPresentation()
        let (window, controller) = try makeSidebarController(presentation)
        defer { window.isHidden = true }
        try XCTSkipIf(hasVerticalBar(controller), "A vertical bar presents the sidebar over the screen")
        let sidebar = controller.children[0].view!
        let content = controller.children[1].view!

        presentation.isPresented = true
        controller.view.layoutIfNeeded()

        XCTAssertEqual(windowFrame(content).minX, controller.revealWidth, accuracy: 0.5)
        XCTAssertTrue(controller.view.subviews.first === sidebar, "The pushed-aside screen must cover the sidebar")
    }

    func testVerticalBarModePresentsOverTheScreen() throws {
        let presentation = AppSidebarPresentation()
        let (window, controller) = try makeSidebarController(presentation)
        defer { window.isHidden = true }
        try XCTSkipUnless(hasVerticalBar(controller), "Needs iOS 27.1 and a vertical bar, as on the iPhone Duo")
        let hosts = controller.children.map(\.view!)
        let sidebar = hosts[0]
        let content = hosts[1]
        controller.view.layoutIfNeeded()
        let closedInsets = hosts.map(\.safeAreaInsets)
        XCTAssertLessThanOrEqual(windowFrame(sidebar).maxX, 0.5, "The closed sidebar must sit off screen")

        presentation.isPresented = true
        controller.view.layoutIfNeeded()
        hosts.forEach { $0.layoutIfNeeded() }

        XCTAssertEqual(windowFrame(content).minX, 0, accuracy: 0.5, "The screen moved away from its vertical bar")
        XCTAssertEqual(windowFrame(sidebar).minX, 0, accuracy: 0.5)
        XCTAssertTrue(controller.view.subviews.last === sidebar, "The sidebar must cover the screen")
        XCTAssertEqual(hosts.map(\.safeAreaInsets), closedInsets, "Opening the sidebar changed a host's safe area")

        presentation.isPresented = false
        controller.view.layoutIfNeeded()

        XCTAssertLessThanOrEqual(windowFrame(sidebar).maxX, 0.5, "The closed sidebar must sit off screen")
    }

    private func windowFrame(_ view: UIView) -> CGRect {
        view.convert(view.bounds, to: nil)
    }

    private func hasVerticalBar(_ controller: UIViewController) -> Bool {
        if #available(iOS 27.1, *) {
            return controller.traitCollection.verticalBarEdge != .unspecified
        }
        return false
    }
}

/// An `AppSidebarController` with empty roots in a window of the test host's scene.
@MainActor
private func makeSidebarController(
    _ presentation: AppSidebarPresentation
) throws -> (UIWindow, AppSidebarController) {
    let scene = try HostedScene.current()
    let window = UIWindow(windowScene: scene)
    let controller = AppSidebarController(presentation: presentation)
    controller.setRoots(sidebar: AnyView(Color.clear), content: AnyView(Color.clear))
    window.rootViewController = controller
    window.makeKeyAndVisible()
    return (window, controller)
}
