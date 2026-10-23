import Foundation

/// TAL-1460: an iPhone Duo propped like a tent (outer display, landscape, hinge partly open) turns the Chats list's
/// running and waiting rows into large run cards readable from arm's length. Any other pose keeps the regular rows.
public enum SessionRunMonitor {
    /// The hinge as the session list root reads it; nil where the device reports no hinge.
    public enum HingeStatus: Sendable, Equatable {
        case closed, partiallyOpen, fullyOpen
    }

    /// The monitor shows only on compact/compact size classes with the hinge partly open while a listed session runs
    /// or waits on the user.
    public static func isActive(
        horizontalSizeClassIsCompact: Bool,
        verticalSizeClassIsCompact: Bool,
        hinge: HingeStatus?,
        sessions: [SessionSummary]
    ) -> Bool {
        horizontalSizeClassIsCompact && verticalSizeClassIsCompact && hinge == .partiallyOpen
            && sessions.contains { runStatus(for: $0, isStopping: false) != nil }
    }

    /// A row's run card status: what waits on the user (`attention`) first, else the live run; nil for an idle row.
    /// The elapsed time counts from the server's `pending_started_at`.
    public static func runStatus(for session: SessionSummary, isStopping: Bool) -> ChatActiveRunStatusPresentation? {
        let startedAt = ChatStreamCoordinator.runStart(fromEpochSeconds: session.pendingStartedAt)
        switch session.attention?.kind {
        case .approval:
            return ChatActiveRunStatusPresentation(kind: .awaitingApproval, runStartedAt: startedAt)
        case .clarify:
            return ChatActiveRunStatusPresentation(kind: .awaitingAnswer, runStartedAt: startedAt)
        case .other:
            return ChatActiveRunStatusPresentation(kind: .awaitingInput, runStartedAt: startedAt)
        case nil:
            guard session.isStreaming == true else { return nil }
            return ChatActiveRunStatusPresentation(kind: isStopping ? .stopping : .active, runStartedAt: startedAt)
        }
    }
}
