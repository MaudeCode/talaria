import Darwin
import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// Window sizes hosted presentation tests lay a screen out in (TAL-856).
enum HostedSize {
    static let phone = CGSize(width: 390, height: 844)
    static let phoneLandscape = CGSize(width: 844, height: 390)
    static let padLandscape = CGSize(width: 1194, height: 834)
    /// The iPhone Duo's displays, measured on its simulator (TAL-1453). The inner display is regular in both
    /// dimensions, so it takes the split view.
    static let duoOuter = CGSize(width: 466, height: 678)
    static let duoOuterLandscape = CGSize(width: 678, height: 466)
    static let duoInner = CGSize(width: 669, height: 951)
    static let duoInnerLandscape = CGSize(width: 951, height: 669)
}

/// Reads the public UIKit items SwiftUI emits, including grouped and bottom-bar actions.
extension HostedAccessibility {
    /// The page supplying the visible title menu, beyond sidebar and inspector navigation wrappers.
    static func titleMenuController(in window: UIWindow) -> UIViewController? {
        func find(_ controller: UIViewController) -> UIViewController? {
            if let navigation = controller as? UINavigationController, let top = navigation.topViewController {
                return find(top)
            }
            if let menu = controller.navigationItem.titleMenuProvider?([]), !menu.children.isEmpty { return controller }
            for child in controller.children {
                if let page = find(child) { return page }
            }
            return nil
        }
        return window.rootViewController.flatMap(find)
    }

    static func menuActions(in menu: UIMenu) -> [UIAction] {
        menu.children.flatMap { element -> [UIAction] in
            // SwiftUI represents the informational full title as a disabled, imageless item.
            if let action = element as? UIAction {
                return action.image == nil && action.attributes.contains(.disabled) ? [] : [action]
            }
            if let nested = element as? UIMenu { return menuActions(in: nested) }
            return []
        }
    }

    static func toolbarItems(in window: UIWindow) -> [UIBarButtonItem] {
        window.rootViewController.map(toolbarItems(under:)) ?? []
    }

    /// The items one controller and its children show, such as one column of a split view.
    static func toolbarItems(under root: UIViewController) -> [UIBarButtonItem] {
        var result: [UIBarButtonItem] = []
        var visited: Set<ObjectIdentifier> = []
        func visit(_ controller: UIViewController) {
            guard visited.insert(ObjectIdentifier(controller)).inserted,
                  let view = controller.viewIfLoaded, view.window != nil,
                  !view.isHidden, !view.accessibilityElementsHidden else { return }
            let navigation = controller as? UINavigationController
            let navigationItems = [controller.navigationItem] + [navigation?.navigationBar.topItem].compactMap { $0 }
            result += controller.toolbarItems ?? []
            for item in navigationItems {
                result += (item.leftBarButtonItems ?? []) + (item.rightBarButtonItems ?? [])
                result += (item.leadingItemGroups + item.trailingItemGroups).flatMap(\.barButtonItems)
            }
            if let navigation, let visible = navigation.visibleViewController {
                visit(visible)
            } else {
                controller.children.forEach(visit)
            }
            if let presented = controller.presentedViewController { visit(presented) }
        }
        visit(root)
        var seen: Set<ObjectIdentifier> = []
        return result.filter { seen.insert(ObjectIdentifier($0)).inserted }
    }

    /// The regular-width split view; the chat's inspector is a split view controller of its own.
    static func splitViewController(under controller: UIViewController?) -> UISplitViewController? {
        guard let controller else { return nil }
        var candidates: [UISplitViewController] = []
        func collect(_ current: UIViewController) {
            if let split = current as? UISplitViewController { candidates.append(split) }
            current.children.forEach(collect)
        }
        collect(controller)
        // The detail-level inspector also uses UISplitViewController, with its own default 320pt primary.
        // Identify the app split by its sidebar, preferring it over an inspector that wraps the app split.
        if let appSplit = candidates.reversed().first(where: { split in
            guard let primary = split.viewController(for: .primary), primary.isViewLoaded else { return false }
            return primary.view.firstView(ofType: UICollectionView.self, where: { $0.accessibilityIdentifier == "app-sidebar" }) != nil
        }) { return appSplit }
        return candidates.first { !NSStringFromClass(type(of: $0)).contains("Inspector") }
    }

    static func toolbarItem(_ title: String, in window: UIWindow) -> UIBarButtonItem? {
        toolbarItems(in: window).first { $0.title == title || $0.accessibilityLabel == title || $0.primaryAction?.title == title }
    }

    /// The system may move an action into its overflow menu instead of mounting a visible bar control.
    static func toolbarAction(_ title: String, in window: UIWindow) -> NSObject? {
        if let item = toolbarItem(title, in: window) { return item }
        func action(in menu: UIMenu) -> UIAction? {
            for child in menu.children {
                if let action = child as? UIAction, action.title == title { return action }
                if let nested = child as? UIMenu, let found = action(in: nested) { return found }
            }
            return nil
        }
        return toolbarItems(in: window).compactMap(\.menu).lazy.compactMap { action(in: $0) }.first
    }
}

extension XCTestCase {
    @MainActor
    func attachHostedScreenshot(_ window: UIWindow, name: String, lifetime: XCTAttachment.Lifetime = .keepAlways) {
        let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        attachment.name = name
        attachment.lifetime = lifetime
        add(attachment)
    }

    /// Hosts `view` in a window of its own with animations off and returns the window, for tests that assert what a
    /// real screen lays out: which controls exist, their frames and traits, and what activating one does. The window's
    /// image is attached only when the test fails, and the window is hidden at teardown. A view's own window keeps it
    /// clear of the app's live root (TAL-690).
    @MainActor
    @discardableResult
    func hostWindow(
        _ view: some View,
        size: CGSize = HostedSize.phone,
        animationsEnabled: Bool = false,
        traits: (inout UITraitOverrides) -> Void = { _ in }
    ) throws -> UIWindow {
        _ = HostedAccessibility.enableAutomation
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        // A synthetic phone window must not inherit the unfolded Duo/iPad scene's regular size class.
        window.traitOverrides.horizontalSizeClass = size.width >= 600 && size.height >= 600 ? .regular : .compact
        window.traitOverrides.verticalSizeClass = size.height >= 600 ? .regular : .compact
        traits(&window.traitOverrides)
        window.rootViewController = UIHostingController(rootView: view.transaction {
            $0.disablesAnimations = !animationsEnabled
            // Explicit withAnimation transactions survive disablesAnimations alone.
            if !animationsEnabled { $0.animation = nil }
        })
        let animated = UIView.areAnimationsEnabled
        UIView.setAnimationsEnabled(animationsEnabled)
        // Key and visible, so appearance callbacks reach the screen's view controllers as they do in the app.
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        settle()
        addTeardownBlock { [weak self] in
            MainActor.assumeIsolated {
                if self?.testRun?.hasSucceeded == false {
                    self?.attachHostedScreenshot(window, name: "\(self?.name ?? "hosted") window", lifetime: .deleteOnSuccess)
                }
                window.isHidden = true
                window.rootViewController = nil
                UIView.setAnimationsEnabled(animated)
            }
        }
        return window
    }

    /// Lets SwiftUI apply pending updates: a few run-loop turns, which is how long state changes and `.task` starts take
    /// to reach the hosted tree.
    @MainActor
    func settle(_ seconds: TimeInterval = 0.05) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    /// Pumps the run loop until `condition` holds or `timeout` passes, and reports whether it held. Network-driven
    /// screens use it to wait for the in-process fixture's answers.
    @MainActor
    @discardableResult
    func waitUntil(timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return condition() }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        return true
    }
}

/// Reads a hosted window's accessibility tree, the same tree VoiceOver and XCUITest see, without OCR (TAL-856).
@MainActor
enum HostedAccessibility {
    /// SwiftUI builds its accessibility tree only while an assistive technology is on; XCUITest turns automation on for
    /// the App it drives. Hosted tests turn it on for their own process the same way, once (KIF's approach).
    static let enableAutomation: Void = {
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else { return }
        typealias SetEnabled = @convention(c) (Int32) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(1)
    }()

    /// Every accessibility element under `root`, depth first.
    static func elements(in root: NSObject) -> [NSObject] {
        _ = enableAutomation
        var found: [NSObject] = []
        visit(root, into: &found)
        return found
    }

    static func element(in root: NSObject, identifier: String) -> NSObject? {
        elements(in: root).first { self.identifier(of: $0) == identifier }
    }

    /// SwiftUI's elements answer `accessibilityIdentifier` without declaring `UIAccessibilityIdentification`.
    static func identifier(of element: NSObject) -> String? {
        let getter = NSSelectorFromString("accessibilityIdentifier")
        guard element.responds(to: getter) else { return nil }
        return element.perform(getter)?.takeUnretainedValue() as? String
    }

    static func element(in root: NSObject, label: String) -> NSObject? {
        elements(in: root).first { $0.accessibilityLabel == label }
    }

    static func elements(in root: NSObject, labelContaining text: String) -> [NSObject] {
        elements(in: root).filter { $0.accessibilityLabel?.contains(text) == true }
    }

    static func labels(in root: NSObject) -> [String] {
        elements(in: root).compactMap(\.accessibilityLabel)
    }

    /// Taps an alert's button: SwiftUI alerts are `UIAlertController`s, whose buttons ignore `accessibilityActivate`.
    /// Completes the harness's manual dismissal before dispatching an action that may present another alert.
    static func tap(
        _ title: String,
        in alert: UIAlertController,
        dismiss: @MainActor (UIAlertController, @escaping () -> Void) -> Void = { alert, completion in
            alert.dismiss(animated: false, completion: completion)
        }
    ) -> Bool {
        guard let action = alert.actions.first(where: { $0.title == title }),
              let handler = action.value(forKey: "handler") else { return false }
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        dismiss(alert) {
            unsafeBitCast(handler as AnyObject, to: Handler.self)(action)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        return true
    }

    /// Performs the element's default action, as a VoiceOver double tap does, then lets the result reach the tree.
    @discardableResult
    static func activate(_ element: NSObject) -> Bool {
        let handled: Bool
        if let item = element as? UIBarButtonItem {
            guard item.isEnabled else { return false }
            if let primary = item.primaryAction { return activate(primary) }
            guard let action = item.action else { return false }
            handled = UIApplication.shared.sendAction(action, to: item.target, from: item, for: nil)
        } else if let action = element as? UIAction {
            guard !action.attributes.contains(.disabled) else { return false }
            let control = UIControl()
            control.addAction(action, for: .primaryActionTriggered)
            control.sendActions(for: .primaryActionTriggered)
            handled = true
        } else if let control = element as? UIControl {
            guard control.isEnabled else { return false }
            control.sendActions(for: control.allControlEvents.contains(.primaryActionTriggered)
                ? .primaryActionTriggered : .touchUpInside)
            handled = true
        } else {
            handled = element.accessibilityActivate()
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        return handled
    }

    private static func visit(_ object: NSObject, into found: inout [NSObject]) {
        // UIKit keeps offscreen hosts mounted. VoiceOver deliberately excludes their hidden accessibility subtrees.
        guard !object.accessibilityElementsHidden, (object as? UIView)?.isHidden != true else { return }
        if object.isAccessibilityElement { found.append(object) }
        if let children = object.accessibilityElements as? [NSObject], !children.isEmpty {
            children.forEach { visit($0, into: &found) }
            return
        }
        let count = object.accessibilityElementCount()
        if count != NSNotFound, count > 0 {
            (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject }.forEach { visit($0, into: &found) }
            return
        }
        (object as? UIView)?.subviews.forEach { visit($0, into: &found) }
    }
}

extension UIView {
    /// Whether a view of `type` is anywhere under this one.
    func containsView<View: UIView>(ofType type: View.Type) -> Bool {
        firstView(ofType: type) != nil
    }

    /// The first view of `type` under this one, depth first.
    func firstView<View: UIView>(ofType type: View.Type, where predicate: (View) -> Bool = { _ in true }) -> View? {
        if let match = self as? View, predicate(match) { return match }
        for child in subviews {
            if let match = child.firstView(ofType: type, where: predicate) { return match }
        }
        return nil
    }
}

extension UIViewController {
    func firstDescendant<Controller: UIViewController>(ofType type: Controller.Type) -> Controller? {
        if let match = self as? Controller { return match }
        for child in children + [presentedViewController].compactMap({ $0 }) {
            if let match = child.firstDescendant(ofType: type) { return match }
        }
        return nil
    }
}
