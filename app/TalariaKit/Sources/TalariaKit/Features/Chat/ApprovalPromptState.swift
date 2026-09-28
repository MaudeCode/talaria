
public struct ApprovalPromptState: Equatable, Identifiable {
    public var id: String {
        "\(sessionID)-\(pending.id)"
    }

    let sessionID: String
    public let pending: PendingApproval
    public let pendingCount: Int

    public var patternKeys: [String] {
        pending.displayPatternKeys
    }
}
