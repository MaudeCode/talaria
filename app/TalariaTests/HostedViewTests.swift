import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The hosted-test harness itself (TAL-856): a hosted SwiftUI screen exposes its controls through the accessibility
/// tree, activating one runs its action, and the in-process fixture answers the App's requests.
@MainActor
final class HostedViewTests: XCTestCase {
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
