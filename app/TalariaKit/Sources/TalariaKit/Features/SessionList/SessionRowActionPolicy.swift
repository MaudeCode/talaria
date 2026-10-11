import Foundation

public enum SessionRowActionPolicy {
    /// Rename and Move follow `read_only`, as the server's own rename and move checks do.
    public static func offersMutationActions(for session: SessionSummary) -> Bool {
        !session.isSessionReadOnly
    }

    /// The server's own gates (TAL-312, TAL-627); a row without one (cached before TAL-723) offers no action.
    public static func canPin(_ session: SessionSummary) -> Bool {
        session.canPin == true
    }

    public static func canArchive(_ session: SessionSummary) -> Bool {
        session.canArchive == true
    }

    public static func canDelete(_ session: SessionSummary) -> Bool {
        session.canDelete == true
    }

    /// A row Select Chats can pick: the server allows archiving or deleting it.
    public static func isBulkSelectable(_ session: SessionSummary) -> Bool {
        hasServerSessionID(session) && (canArchive(session) || canDelete(session))
    }

    public static func canDuplicate(_ session: SessionSummary) -> Bool {
        session.canDuplicate == true
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
