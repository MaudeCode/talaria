import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// The hosted-test harness itself (TAL-856): a hosted SwiftUI screen exposes its controls through the accessibility
/// tree, activating one runs its action, and the in-process fixture answers the App's requests.
@MainActor
final class HostedViewTests: XCTestCase {
    func testControlActivationUsesItsRegisteredEventOnceAndHonorsDisabledState() {
        let eventSets: [UIControl.Event] = [.touchUpInside, .primaryActionTriggered, [.touchUpInside, .primaryActionTriggered]]
        for events in eventSets {
            var invocations = 0
            let control = UIControl()
            control.addAction(UIAction { _ in invocations += 1 }, for: events)
            XCTAssertTrue(HostedAccessibility.activate(control))
            XCTAssertEqual(invocations, 1, "The control's default action must run exactly once for \(events)")
            control.isEnabled = false
            XCTAssertFalse(HostedAccessibility.activate(control))
            XCTAssertEqual(invocations, 1, "A disabled control must not run its action")
        }
    }

    func testNativePrimaryActionRunsOnceAndDisabledItemsDoNotRun() {
        var invocations = 0
        let item = UIBarButtonItem(primaryAction: UIAction(title: "Fixture action") { _ in invocations += 1 })
        XCTAssertTrue(HostedAccessibility.activate(item))
        XCTAssertEqual(invocations, 1)
        item.isEnabled = false
        XCTAssertFalse(HostedAccessibility.activate(item))
        XCTAssertEqual(invocations, 1)
    }

    func testCoveredNavigationPagesDoNotSupplyToolbarActions() throws {
        let root = UIViewController()
        root.navigationItem.rightBarButtonItem = UIBarButtonItem(primaryAction: UIAction(title: "Covered action") { _ in })
        let top = UIViewController()
        var invocations = 0
        top.navigationItem.rightBarButtonItem = UIBarButtonItem(primaryAction: UIAction(title: "Visible action") { _ in invocations += 1 })
        let window = try hostWindow(Color.clear)
        let navigation = UINavigationController(rootViewController: root)
        window.rootViewController = navigation
        navigation.pushViewController(top, animated: false)
        window.layoutIfNeeded()
        settle()
        XCTAssertNil(HostedAccessibility.toolbarItem("Covered action", in: window))
        let action = try XCTUnwrap(HostedAccessibility.toolbarItem("Visible action", in: window))
        XCTAssertTrue(HostedAccessibility.activate(action))
        XCTAssertEqual(invocations, 1)
    }

    func testAlertActionWaitsForManualDismissalBeforeRequestingAnotherWarning() throws {
        let alert = UIAlertController(title: "Model warning", message: nil, preferredStyle: .alert)
        var refreshRequests = 0
        alert.addAction(UIAlertAction(title: "Refresh warning", style: .default) { _ in refreshRequests += 1 })
        var finishDismissal: (() -> Void)?
        XCTAssertTrue(HostedAccessibility.tap("Refresh warning", in: alert, dismiss: { _, completion in
            finishDismissal = completion
        }))
        XCTAssertEqual(refreshRequests, 0, "A refreshed warning must not race the harness's unfinished dismissal")
        try XCTUnwrap(finishDismissal)()
        XCTAssertEqual(refreshRequests, 1, "Completing dismissal must dispatch the selected action exactly once")
    }

    func testHostedWindowDisablesExplicitSwiftUIAnimations() async throws {
        // Reuse the real message marker to observe committed SwiftUI geometry.
        struct AnimatedMarker: View {
            @State private var expanded = false
            var body: some View {
                VStack {
                    Button("Expand test marker") {
                        withAnimation(.linear(duration: 2)) { expanded = true }
                    }
                    Text(expanded ? "Expanded marker" : "Collapsed marker")
                    ChatMessageInteractionMarker(registry: nil, content: { nil })
                        .frame(width: 100, height: expanded ? 200 : 20)
                }
            }
        }
        let window = try hostWindow(AnimatedMarker())
        let marker = try XCTUnwrap(window.firstView(ofType: ChatMessageInteractionMarkerView.self))
        XCTAssertEqual(marker.bounds.height, 20, accuracy: 0.5)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Expand test marker"))
        _ = try await requireElement(in: window, label: "Expanded marker")
        window.layoutIfNeeded()
        XCTAssertEqual(marker.bounds.height, 200, accuracy: 0.5,
                       "A non-animated hosted window must clear explicit SwiftUI animations before measuring")

        let animatedWindow = try hostWindow(AnimatedMarker(), animationsEnabled: true)
        let animatedMarker = try XCTUnwrap(animatedWindow.firstView(ofType: ChatMessageInteractionMarkerView.self))
        HostedAccessibility.activate(try await requireElement(in: animatedWindow, label: "Expand test marker"))
        _ = try await requireElement(in: animatedWindow, label: "Expanded marker")
        animatedWindow.layoutIfNeeded()
        XCTAssertLessThan(animatedMarker.bounds.height, 200,
                          "Opting into animations must keep the explicit transition")
    }

    func testViewLookupVisitsEachBranchOnce() {
        final class Probe: UIView {
            var reads = 0
            override var subviews: [UIView] { reads += 1; return super.subviews }
        }
        let root = Probe()
        let child = Probe()
        let target = UIButton()
        root.addSubview(child)
        child.addSubview(target)
        root.reads = 0
        child.reads = 0
        XCTAssertTrue(root.firstView(ofType: UIButton.self) === target)
        XCTAssertEqual(root.reads, 1)
        XCTAssertEqual(child.reads, 1, "Nested view lookup must not repeat the same subtree")
    }

    func testMessageMenuRegistryRetainsAMarkerAcrossTemporaryDetachment() throws {
        let window = try hostWindow(Color.clear)
        let marker = UIView(frame: CGRect(x: 16, y: 16, width: 100, height: 100))
        let registry = ChatMessageMenuRegistry()
        registry.register(marker) {
            ChatMessageMenuContent(messageID: "remounted-reader", actions: [], linkRegions: [], controlRegions: [])
        }
        let point = CGPoint(x: 32, y: 32)
        XCTAssertNil(registry.hit(at: point, in: window), "An unmounted row must never route an action")
        window.addSubview(marker)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "remounted-reader")
        marker.removeFromSuperview()
        XCTAssertNil(registry.hit(at: point, in: window))
        window.addSubview(marker)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "remounted-reader")
    }

    func testMessageMenuMarkerReregistersAfterReparentingWithoutAnUpdate() throws {
        let registry = ChatMessageMenuRegistry()
        let content = { ChatMessageMenuContent(messageID: "reparented-reader", actions: [], linkRegions: [], controlRegions: []) }
        let window = try hostWindow(ChatMessageInteractionMarker(registry: registry, content: content).frame(width: 100, height: 100))
        let marker = try XCTUnwrap(window.firstView(ofType: ChatMessageInteractionMarkerView.self))
        let parent = try XCTUnwrap(marker.superview)
        let index = try XCTUnwrap(parent.subviews.firstIndex(of: marker))
        registry.register(marker, content: content)
        let point = marker.convert(CGPoint(x: 50, y: 50), to: window)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "reparented-reader")
        marker.removeFromSuperview()
        XCTAssertNil(registry.hit(at: point, in: window))
        parent.insertSubview(marker, at: index)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "reparented-reader")
        ChatMessageInteractionMarker.dismantleUIView(marker, coordinator: ())
        marker.removeFromSuperview()
        parent.insertSubview(marker, at: index)
        XCTAssertNil(registry.hit(at: point, in: window), "Dismantling must prevent stale actions from returning")
    }

    func testTypingFindsAnExpandedComposerThatAppearsAfterTheFirstProbe() async throws {
        let window = try hostWindow(Color.clear)
        let editor = UITextView(frame: CGRect(x: 16, y: 100, width: 300, height: 44))
        let insertion = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(2_400))
            guard !Task.isCancelled else { return }
            window.addSubview(editor)
        }
        defer {
            insertion.cancel()
            editor.resignFirstResponder()
            editor.removeFromSuperview()
        }
        try await typeIntoComposer("Delayed editor input", in: window)
        XCTAssertEqual(editor.text, "Delayed editor input")
    }

    func testAHostedButtonIsFoundByItsIdentifierAndActivates() throws {
        var taps = 0
        let window = try hostWindow(
            VStack {
                Text("Heading")
                Button("Do It") { taps += 1 }
                    .accessibilityIdentifier("hosted-button")
            }
        )
        let button = try XCTUnwrap(
            HostedAccessibility.element(in: window, identifier: "hosted-button"),
            "Elements: \(HostedAccessibility.labels(in: window))"
        )
        XCTAssertEqual(button.accessibilityLabel, "Do It")
        XCTAssertTrue(button.accessibilityTraits.contains(.button))
        HostedAccessibility.activate(button)
        XCTAssertEqual(taps, 1)
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Heading"))
    }

    func testTheInProcessFixtureAnswersTheSessionList() async throws {
        let fixture = try FixtureApp(for: self)
        let response = try await fixture.client.sessions()
        XCTAssertTrue(response.sessions?.contains { $0.sessionId == UITestFixtureURLProtocol.sessionID } == true)
    }
}
