import Foundation
@testable import TalariaKit
import XCTest

/// TAL-1967: a proposal's transcript card, from the shared contract fixture.
@MainActor
final class ProposalCardModelTests: XCTestCase {
    nonisolated static func fixture(_ key: String) throws -> String {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("proposal")) as? [String: Any])
        return String(decoding: try JSONSerialization.data(withJSONObject: XCTUnwrap(root[key])), as: UTF8.self)
    }

    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> ProposalCardModel {
        let host = "proposals-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config))
        return ProposalCardModel(proposalID: "pr_0a1b2c3d", client: client)
    }

    private static func isApprove(_ request: URLRequest) -> Bool {
        request.httpMethod == "POST" && request.url?.path == "/api/proposals/pr_0a1b2c3d/approve"
    }

    func testTheCardShowsTheServersChangeAsSent() async throws {
        let model = model { $0.complete(withJSON: try! Self.fixture("proposal")) }
        await model.load()
        let proposal = try XCTUnwrap(model.proposal)
        XCTAssertEqual(proposal.summary, "Add MCP server notes")
        XCTAssertEqual(proposal.status, .pending)
        XCTAssertEqual(proposal.diff.map(\.kind), [.addition, .addition, .addition])
        XCTAssertEqual(proposal.diff.first?.text, "+command: npx")
        XCTAssertEqual(proposal.riskNotes.count, 2)
        XCTAssertEqual(proposal.actions, Proposal.Actions(canApprove: true, canReject: true))
    }

    func testApproveShowsAtOnceSendsTheReviewedHashAndAdoptsTheServersOutcome() async throws {
        let pending = try Self.fixture("proposal")
        let applied = try Self.fixture("applied")
        let writes = DeferredRequests()
        let arrived = expectation(description: "approve held")
        let model = model { request in
            if Self.isApprove(request.request) {
                _ = writes.append(request)
                arrived.fulfill()
            } else { request.complete(withJSON: pending) }
        }
        await model.load()
        let approve = Task { await model.approve() }
        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertEqual(model.proposal?.status, .approved, "Shown before the server answers")
        XCTAssertEqual(model.proposal?.actions, Proposal.Actions(canApprove: false, canReject: false))
        let body = try apiTestJSONBody(from: writes.request(at: 0).request)
        XCTAssertEqual(body["payload_hash"] as? String, "5f1c0e9a2b7d4c13")

        writes.request(at: 0).complete(withJSON: applied)
        await approve.value
        XCTAssertEqual(model.proposal?.status, .applied)
        XCTAssertEqual(model.proposal?.outcome.text, "Scheduled Morning digest (job-1).")
        XCTAssertNil(model.lastError)
    }

    func testARefusedDecisionRollsBackToTheServersCopy() async throws {
        let pending = try Self.fixture("proposal")
        let model = model { request in
            if Self.isApprove(request.request) {
                request.complete(withJSON: #"{"error":"This proposal is not the version that was reviewed.","code":"payload_changed"}"#, statusCode: 409)
            } else { request.complete(withJSON: pending) }
        }
        await model.load()
        await model.approve()
        XCTAssertEqual(model.proposal?.status, .pending)
        XCTAssertEqual(model.proposal?.actions.canApprove, true)
        XCTAssertNotNil(model.lastError)
    }

    func testAnUnknownOutcomeIsDecidedByTheNextRead() async throws {
        let pending = try Self.fixture("proposal")
        let applied = try Self.fixture("applied")
        let approved = LockedTestValue(false)
        let model = model { request in
            if Self.isApprove(request.request) {
                approved.value = true
                request.fail(with: URLError(.networkConnectionLost))
            } else { request.complete(withJSON: approved.value ? applied : pending) }
        }
        await model.load()
        await model.approve()
        XCTAssertEqual(model.proposal?.status, .applied, "The server took the approval before the connection dropped")
        XCTAssertNil(model.lastError)
    }

    func testADecisionWhoseOutcomeStaysUnknownGivesWayToTheNextSuccessfulRead() async throws {
        let pending = try Self.fixture("proposal")
        let applied = try Self.fixture("applied")
        /// nil while the connection is down; otherwise what a read answers.
        let reads = LockedTestValue<String?>(pending)
        let model = model { request in
            if Self.isApprove(request.request) {
                reads.value = nil
                request.fail(with: URLError(.networkConnectionLost))
            } else if let body = reads.value {
                request.complete(withJSON: body)
            } else { request.fail(with: URLError(.notConnectedToInternet)) }
        }
        await model.load()
        // The approval and its reconciling read both lose the connection: the decision stays shown.
        await model.approve()
        XCTAssertEqual(model.proposal?.status, .approved)
        XCTAssertNotNil(model.lastError)
        // The connection returns and the `proposal` event's read shows what the server did.
        reads.value = applied
        await model.load()
        XCTAssertEqual(model.proposal?.status, .applied)
        XCTAssertNil(model.lastError)
    }

    func testANonOwnerCardSendsNoDecision() async throws {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture("proposal").utf8)) as? [String: Any])
        root["actions"] = ["can_approve": false, "can_reject": false, "reason": "not_owner"]
        let withheld = String(decoding: try JSONSerialization.data(withJSONObject: root), as: UTF8.self)
        let requests = DeferredRequests()
        let model = model { request in
            _ = requests.append(request)
            request.complete(withJSON: withheld)
        }
        await model.load()
        XCTAssertEqual(model.proposal?.actions, Proposal.Actions(canApprove: false, canReject: false))
        await model.approve()
        await model.reject()
        XCTAssertEqual(requests.count, 1, "Only the read")
    }

    func testTheReferenceAndEventDecodeFromAToolResultAndTheSessionStream() throws {
        let ref = try Self.fixture("ref")
        let event = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-propose","name":"propose","result_view":{"text":"pending","proposal":\#(ref)}}"#.utf8))
        XCTAssertEqual(event.resultView?.proposal, ProposalRef(proposalId: "pr_0a1b2c3d", kind: "mcp_server", summary: "Add MCP server notes"))
        XCTAssertEqual(
            SessionEventFrameDecoder.decode(eventType: "proposal", data: try Self.fixture("event")),
            .proposal(ProposalEvent(sessionId: "synthetic-session", proposalId: "pr_0a1b2c3d"))
        )
        XCTAssertEqual(SessionEventFrameDecoder.decode(eventType: "proposal", data: #"{"session_id":"s"}"#), .ignored)
    }
}
