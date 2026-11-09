import Foundation
import Observation

/// TAL-1967: a proposal's transcript card. `proposal` is the server's last copy with this user's unconfirmed decision
/// laid over it (root rule: optimistic writes): Approve or Reject shows at once, a refusal rolls back to the server's
/// copy, and an unknown outcome keeps the decision shown until a read decides.
@MainActor
@Observable
public final class ProposalCardModel {
    public let proposalID: String
    /// A failed decision or load, for the card's error presentation.
    public private(set) var lastError: Error?
    private var confirmed: Proposal?
    private var decision: Proposal.Status?
    @ObservationIgnored private let client: APIClient

    public init(proposalID: String, client: APIClient) {
        self.proposalID = proposalID
        self.client = client
    }

    /// The proposal as shown: the server's copy, or the user's decision while it is unconfirmed.
    public var proposal: Proposal? {
        guard var shown = confirmed else { return nil }
        if let decision {
            shown.status = decision
            shown.actions = Proposal.Actions(canApprove: false, canReject: false)
        }
        return shown
    }

    /// Reads the server's copy; a failed read keeps what is shown.
    @discardableResult
    public func load() async -> Bool {
        do {
            confirmed = try await client.proposal(id: proposalID)
            return true
        } catch {
            if !APIError.isCancellation(error), confirmed == nil { lastError = error }
            return false
        }
    }

    public func approve() async {
        guard let shown = proposal, shown.actions.canApprove else { return }
        await decide(.approved) { try await $0.approveProposal(id: shown.proposalId, payloadHash: shown.payloadHash) }
    }

    public func reject() async {
        guard let shown = proposal, shown.actions.canReject else { return }
        await decide(.rejected) { try await $0.rejectProposal(id: shown.proposalId) }
    }

    private func decide(_ status: Proposal.Status, _ write: (APIClient) async throws -> Proposal) async {
        decision = status
        lastError = nil
        do {
            confirmed = try await write(client)
            decision = nil
        } catch {
            if APIError.isCancellation(error) {
                decision = nil
            } else if APIError.isDefinitiveWriteFailure(error) {
                decision = nil
                lastError = error
                await load()
            } else if await load() {
                // Unknown outcome: the server's copy decides, and an unchanged pending one means it never took the decision.
                decision = nil
                if confirmed?.status == .pending { lastError = error }
            } else {
                lastError = error
            }
        }
    }
}
