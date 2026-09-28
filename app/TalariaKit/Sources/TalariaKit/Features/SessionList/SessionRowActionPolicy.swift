import Foundation

public enum SessionRowActionPolicy {
    public static func offersMutationActions(for session: SessionSummary) -> Bool {
        !session.isSessionReadOnly
    }

    /// The server's own gates (TAL-312); an older server that omits them keeps the earlier rules.
    public static func canPin(_ session: SessionSummary) -> Bool {
        session.canPin ?? offersMutationActions(for: session)
    }

    public static func canArchive(_ session: SessionSummary) -> Bool {
        session.canArchive ?? offersMutationActions(for: session)
    }

    public static func canDuplicate(_ session: SessionSummary) -> Bool {
        session.canDuplicate ?? (offersMutationActions(for: session) && !session.isExternalSourceSession)
    }

    public static func canExport(_ session: SessionSummary, isViewingCachedData: Bool) -> Bool {
        !isViewingCachedData && hasServerSessionID(session)
    }

    public static func deepLinkURL(
        for session: SessionSummary,
        isViewingCachedData: Bool,
        isMutating: Bool
    ) -> URL? {
        guard !isMutating,
              canExport(session, isViewingCachedData: isViewingCachedData),
              let sessionID = session.sessionId
        else {
            return nil
        }

        return TalariaDeepLink.sessionURL(sessionID: sessionID)
    }
}

public func hasServerSessionID(_ session: SessionSummary) -> Bool {
    guard let sessionID = session.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) else {
        return false
    }

    return !sessionID.isEmpty
}
