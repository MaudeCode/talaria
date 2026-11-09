import Foundation

/// TAL-1967: the proposal routes (`/api/proposals/…`). Each answers with the whole proposal as this requester sees it.
extension APIClient {
    public func proposal(id: String) async throws -> Proposal {
        try await send(endpoint: .proposal(id: id), method: "GET")
    }

    /// Approves exactly the version shown: `payloadHash` is the hash the owner saw.
    public func approveProposal(id: String, payloadHash: String) async throws -> Proposal {
        try await send(endpoint: .proposalApprove(id: id), method: "POST", body: ProposalApproveRequest(payloadHash: payloadHash))
    }

    public func rejectProposal(id: String) async throws -> Proposal {
        try await send(endpoint: .proposalReject(id: id), method: "POST")
    }
}

struct ProposalApproveRequest: Encodable {
    let payloadHash: String
}
