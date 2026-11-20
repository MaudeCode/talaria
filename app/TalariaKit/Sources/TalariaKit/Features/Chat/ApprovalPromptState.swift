
public struct ApprovalPromptState: Equatable, Identifiable, Sendable {
    public var id: String {
        "\(sessionID)-\(pending.id)"
    }

    let sessionID: String
    public let pending: PendingApproval
    public let pendingCount: Int

    /// TAL-974: what Allow session and Always allow cover, in the sentence Web shows for the same approval; nil when the
    /// server sends no scope.
    public var scopeSentence: String? {
        guard let scope = pending.scope else { return nil }
        let subject = scope.subject ?? ""
        let session = switch scope.kind {
        case .commandPattern: String(localized: "Allow session covers every command flagged “\(subject)” for this session.")
        case .toolRule: String(localized: "Allow session covers \(subject) calls for this reason for this session.")
        case .python: String(localized: "Allow session covers every Python script for this session.")
        case .sshConfig: String(localized: "Allow session covers writes to SSH config for this session.")
        case .computerUse: String(localized: "Allow session covers the computer-use action \(subject) for this session.")
        case .securityFinding: String(localized: "Allow session covers this security finding for this session.")
        case .unknown: String(localized: "Allow session covers every action like this one for this session.")
        }
        guard pending.allows(.always) else { return session }
        let always = scope.alwaysIsSessionOnly
            ? String(localized: "Always allow keeps the security finding to this session.")
            : String(localized: "Always allow covers it on this server from now on.")
        return "\(session) \(always)"
    }
}
