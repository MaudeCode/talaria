import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1967: a proposal's transcript card, drawn from the shared `contracts/fixtures/proposal.json` on the phone and
/// both Duo displays.
@MainActor
final class ProposalHostedTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private func proposalFixture(_ key: String) throws -> Data {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("proposal")) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: XCTUnwrap(root[key]))
    }

    /// A tool card for the fixture's `propose` call whose proposal reads answer with `key`.
    private func card(_ key: String) throws -> some View {
        let body = try proposalFixture(key)
        MockURLProtocol.requestHandler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://proposals.test")!, session: URLSession(configuration: configuration))
        let reference = try DecisionReview.decoder.decode(ProposalRef.self, from: proposalFixture("ref"))
        let call = ToolCall(id: "call-propose", name: "propose", preview: nil, args: nil, resultView: ToolResultView(proposal: reference), isCompleted: true)
        return ScrollView { ToolCallCardView(toolCall: call).padding() }
            .chatEnvironmentAction(\.chatProposalModel) { ProposalCardModel(proposalID: $0, client: client) }
    }

    func testThePendingCardShowsTheChangeAndBothActionsOnThePhoneAndBothDuoDisplays() throws {
        for (name, size) in [("phone", HostedSize.phone), ("duo-outer", HostedSize.duoOuter), ("duo-inner", HostedSize.duoInner)] {
            let window = try hostWindow(card("proposal"), size: size)
            XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "proposal-approve-pr_0a1b2c3d") != nil }, name)
            XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "proposal-reject-pr_0a1b2c3d"), name)
            for label in ["Add MCP server notes", "Waiting for approval", "+command: npx", "Passes NOTES_TOKEN"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: label).isEmpty, "\(name): \(label)")
            }
            attachHostedScreenshot(window, name: "proposal-pending-\(name)")
        }
    }

    func testAnAppliedCardShowsItsOutcomeAndNoActions() throws {
        let window = try hostWindow(card("applied"))
        XCTAssertTrue(waitUntil { !HostedAccessibility.elements(in: window, labelContaining: "Scheduled Morning digest (job-1).").isEmpty })
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Applied").isEmpty)
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "proposal-approve-pr_0a1b2c3d"))
        attachHostedScreenshot(window, name: "proposal-applied-phone")
    }
}
