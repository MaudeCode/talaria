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

    override func setUp() async throws {
        try await super.setUp()
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    }

    override func tearDown() async throws {
        window.isHidden = true
        window = nil
        try await super.tearDown()
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
    func testReenablingAClosedDrawerDoesNotExposeItsToolbar() throws {
        let presentation = AppSidebarPresentation()
        let (window, controller) = try makeSidebarController(presentation)
        defer { window.isHidden = true }
        controller.isEnabled = false
        controller.isEnabled = true
        XCTAssertFalse(presentation.isVisible, "Layout admission must not reveal an already closed drawer's toolbar")
    }

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

/// A drag that catches the drawer between its endpoints continues from where it is on screen, for
/// movement and for where a release settles (TAL-2568).
@MainActor
final class AppSidebarDragTakeoverTests: XCTestCase {
    private struct Case: CustomStringConvertible {
        var overlays: Bool
        var isRightToLeft: Bool
        /// Caught on the way open (closed at rest, so the edge pan grabs it), else on the way closed.
        var opening: Bool
        var description: String { "overlays \(overlays), RTL \(isRightToLeft), opening \(opening)" }
    }

    private let cases = [false, true].flatMap { overlays in
        [false, true].flatMap { isRightToLeft in
            [false, true].map { Case(overlays: overlays, isRightToLeft: isRightToLeft, opening: $0) }
        }
    }

    func testTakingOverAPartialDrawerContinuesFromItsOnScreenPosition() throws {
        for testCase in cases {
            let (window, controller, presentation, drag) = try caughtAt(0.4, testCase)
            defer { window.isHidden = true }

            drag(.began, 0)
            drag(.changed, 0)
            XCTAssertEqual(progress(controller), 0.4, accuracy: 1e-6, "Zero movement jumped the drawer: \(testCase)")

            // Opening catches finish open; closing catches reverse to closed past the midpoint.
            let delta: CGFloat = testCase.opening ? 0.15 : -0.1
            drag(.changed, delta)
            XCTAssertEqual(progress(controller), 0.4 + delta, accuracy: 1e-6, "\(testCase)")
            drag(.ended, delta)
            XCTAssertEqual(presentation.isPresented, testCase.opening, "Release settled from an endpoint: \(testCase)")
            XCTAssertEqual(progress(controller), testCase.opening ? 1 : 0, accuracy: 1e-6, "\(testCase)")
        }
    }

    func testCancellingATakeoverReturnsToRestAndTheNextDragStartsThere() throws {
        for testCase in cases {
            let (window, controller, presentation, drag) = try caughtAt(0.4, testCase)
            defer { window.isHidden = true }
            let resting: CGFloat = testCase.opening ? 0 : 1

            drag(.began, 0)
            drag(.changed, testCase.opening ? 0.3 : -0.3)
            // Settle without a slide so the next drag starts from the endpoint itself.
            UIView.performWithoutAnimation { drag(.cancelled, 0) }
            XCTAssertEqual(presentation.isPresented, !testCase.opening, "\(testCase)")
            XCTAssertEqual(progress(controller), resting, accuracy: 1e-6, "\(testCase)")

            CATransaction.flush()
            drag(.began, 0)
            drag(.changed, testCase.opening ? 0.2 : -0.2)
            XCTAssertEqual(progress(controller), testCase.opening ? 0.2 : 0.8, accuracy: 1e-6, "\(testCase)")
        }
    }

    /// A drawer at rest dragged to `fraction` and committed on screen, plus a second drag that
    /// takes it over there: the edge pan when it rests closed, the surface pan when it rests open.
    /// `drag` moves by a signed fraction of the reveal width toward open.
    private func caughtAt(
        _ fraction: CGFloat,
        _ testCase: Case
    ) throws -> (UIWindow, AppSidebarController, AppSidebarPresentation, (UIGestureRecognizer.State, CGFloat) -> Void) {
        let presentation = AppSidebarPresentation()
        presentation.isPresented = !testCase.opening
        let (window, controller) = try makeSidebarController(presentation) { controller in
            controller.isRightToLeft = testCase.isRightToLeft
            controller.overlaysContent = testCase.overlays
        }
        controller.view.layoutIfNeeded()
        let handler = NSSelectorFromString(testCase.opening ? "edgePanned:" : "surfacePanned:")
        let direction: CGFloat = testCase.isRightToLeft ? -1 : 1
        func drag(_ state: UIGestureRecognizer.State, _ toward: CGFloat) {
            let pan = ScriptedPan(state: state, x: toward * controller.revealWidth * direction)
            controller.perform(handler, with: pan)
        }
        drag(.began, 0)
        drag(.changed, testCase.opening ? fraction : fraction - 1)
        // The render server now draws the drawer here, as it would between two touches.
        CATransaction.flush()
        return (window, controller, presentation, drag)
    }

    /// The scrim's alpha is the drawer's progress from closed (0) to open (1).
    private func progress(_ controller: AppSidebarController) -> CGFloat {
        controller.children[1].view.superview?.subviews.last?.alpha ?? -1
    }
}

/// A pan whose state and travel the test sets, handed to the container's own handlers.
final class ScriptedPan: UIScreenEdgePanGestureRecognizer {
    private let scriptedState: UIGestureRecognizer.State
    private let x: CGFloat

    init(state: UIGestureRecognizer.State, x: CGFloat) {
        scriptedState = state
        self.x = x
        super.init(target: nil, action: nil)
    }

    override var state: UIGestureRecognizer.State {
        get { scriptedState }
        set {}
    }

    override func translation(in view: UIView?) -> CGPoint { CGPoint(x: x, y: 0) }
    override func velocity(in view: UIView?) -> CGPoint { .zero }
}

/// An `AppSidebarController` with empty roots in a window of the test host's scene.
@MainActor
private func makeSidebarController(
    _ presentation: AppSidebarPresentation,
    configure: (AppSidebarController) -> Void = { _ in }
) throws -> (UIWindow, AppSidebarController) {
    let scene = try HostedScene.current()
    let window = UIWindow(windowScene: scene)
    let controller = AppSidebarController(presentation: presentation)
    controller.setRoots(sidebar: AnyView(Color.clear), content: AnyView(Color.clear))
    configure(controller)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    return (window, controller)
}
