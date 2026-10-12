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
}

extension XCTestCase {
    /// Hosts `view` in a window of its own with animations off and returns the window, for tests that assert what a
    /// real screen lays out: which controls exist, their frames and traits, and what activating one does. The window's
    /// image is attached only when the test fails, and the window is hidden at teardown. A view's own window keeps it
    /// clear of the app's live root (TAL-690).
    @MainActor
    @discardableResult
    func hostWindow(
        _ view: some View,
        size: CGSize = HostedSize.phone,
        traits: (inout UITraitOverrides) -> Void = { _ in }
    ) throws -> UIWindow {
        _ = HostedAccessibility.enableAutomation
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        traits(&window.traitOverrides)
        window.rootViewController = UIHostingController(rootView: view.transaction { $0.disablesAnimations = true })
        let animated = UIView.areAnimationsEnabled
        UIView.setAnimationsEnabled(false)
        // Key and visible, so appearance callbacks reach the screen's view controllers as they do in the app.
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        settle()
        addTeardownBlock { [weak self] in
            MainActor.assumeIsolated {
                if self?.testRun?.hasSucceeded == false {
                    let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                    })
                    attachment.name = "\(self?.name ?? "hosted") window"
                    attachment.lifetime = .deleteOnSuccess
                    self?.add(attachment)
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
    /// Runs the action's handler and dismisses the alert, as a tap does.
    static func tap(_ title: String, in alert: UIAlertController) -> Bool {
        guard let action = alert.actions.first(where: { $0.title == title }),
              let handler = action.value(forKey: "handler") else { return false }
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        alert.dismiss(animated: false)
        unsafeBitCast(handler as AnyObject, to: Handler.self)(action)
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        return true
    }

    /// Performs the element's default action, as a VoiceOver double tap does, then lets the result reach the tree.
    @discardableResult
    static func activate(_ element: NSObject) -> Bool {
        let handled = element.accessibilityActivate()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        return handled
    }

    private static func visit(_ object: NSObject, into found: inout [NSObject]) {
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
    func firstView<View: UIView>(ofType type: View.Type) -> View? {
        self as? View ?? subviews.lazy.compactMap { $0.firstView(ofType: type) }.first
    }
}
