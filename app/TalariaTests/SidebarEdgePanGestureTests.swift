import UIKit
import XCTest
@testable import Talaria

/// The sidebar's edge pan yields to any on-screen stack that can go back and to a sheet,
/// however deep the stack sits in the controller tree (TAL-462).
@MainActor
final class SidebarEdgePanGestureTests: XCTestCase {
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

        XCTAssertFalse(SidebarEdgePanGesture.visibleStackOwnsEdgeSwipe(in: window))

        navigation.pushViewController(UIViewController(), animated: false)
        XCTAssertTrue(SidebarEdgePanGesture.visibleStackOwnsEdgeSwipe(in: window))

        navigation.view.removeFromSuperview()
        XCTAssertFalse(
            SidebarEdgePanGesture.visibleStackOwnsEdgeSwipe(in: window),
            "A stack that is not on screen must not block the sidebar"
        )
    }

    func testASheetOwnsTheEdgeSwipe() {
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        XCTAssertFalse(SidebarEdgePanGesture.visibleStackOwnsEdgeSwipe(in: window))

        root.present(UIViewController(), animated: false)
        XCTAssertTrue(SidebarEdgePanGesture.visibleStackOwnsEdgeSwipe(in: window))
    }

    private func embed(_ child: UIViewController, in parent: UIViewController) {
        parent.addChild(child)
        parent.view.addSubview(child.view)
        child.didMove(toParent: parent)
    }
}
