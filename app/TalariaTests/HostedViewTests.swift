import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// The hosted-test harness itself (TAL-856): a hosted SwiftUI screen exposes its controls through the accessibility
/// tree, activating one runs its action, and the in-process fixture answers the App's requests.
@MainActor
final class HostedViewTests: XCTestCase {
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
