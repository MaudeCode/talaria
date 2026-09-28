import Foundation

public enum SessionNavigationDestination: Hashable, Identifiable {
    case session(SessionSummary)
    case newChat(PendingNewChatRoute)
    case utility(SessionListUtilityDestination)

    public var id: Self { self }

    public var selectedSessionID: String? {
        guard case .session(let session) = self else { return nil }
        return session.sessionId
    }

    public var compactRootUtility: SessionListUtilityDestination? {
        guard case .utility(let utility) = self else { return nil }
        switch utility {
        case .archived, .scheduled, .webhook:
            return nil
        default:
            return utility
        }
    }

    public var compactPushedDestination: Self? {
        guard compactRootUtility == nil else { return nil }
        return self
    }
}

public struct SessionNavigationState: Equatable {
    public private(set) var destination: SessionNavigationDestination?
    public private(set) var lastSelectedSessionID: String?
    public private(set) var rootRevision = 0
    private var newChatSessionID: String?
    private var deepLinkedSessionLoadID: String?

    public init(lastSelectedSessionID: String? = nil) {
        self.lastSelectedSessionID = Self.normalized(lastSelectedSessionID)
    }

    public var selectedSessionID: String? {
        destination?.selectedSessionID ?? newChatSessionID
    }

    public var isCreatingNewChat: Bool {
        guard case .newChat = destination else { return false }
        return newChatSessionID == nil
    }

    public mutating func select(_ session: SessionSummary) {
        rootRevision += 1
        newChatSessionID = nil
        destination = .session(session)
        remember(session)
    }

    public mutating func select(_ route: PendingNewChatRoute) {
        rootRevision += 1
        newChatSessionID = nil
        destination = .newChat(route)
    }

    public mutating func select(_ utility: SessionListUtilityDestination) {
        rootRevision += 1
        newChatSessionID = nil
        destination = .utility(utility)
    }

    public mutating func remember(_ session: SessionSummary) {
        guard let sessionID = Self.normalized(session.sessionId) else { return }
        lastSelectedSessionID = sessionID
        if case .newChat = destination {
            newChatSessionID = sessionID
        }
    }

    /// Advances `rootRevision` like the `select` overloads: clearing the
    /// destination is a navigation the user chose, so work still resolving for the
    /// destination it replaces must not reinstate it.
    public mutating func clearDestination() {
        rootRevision += 1
        destination = nil
        newChatSessionID = nil
    }

    public mutating func beginDeepLinkedSessionLoad(id: String?) -> String? {
        guard deepLinkedSessionLoadID == nil,
              let sessionID = Self.normalized(id)
        else { return nil }

        deepLinkedSessionLoadID = sessionID
        return sessionID
    }

    public mutating func finishDeepLinkedSessionLoad(id: String?) {
        guard Self.normalized(id) == deepLinkedSessionLoadID else { return }
        deepLinkedSessionLoadID = nil
    }

    /// The stored session to restore, or nil when no restore should happen. Deep
    /// links, shared drafts, and App Intent requests take precedence over the stored
    /// selection, and a pending or in-flight deep link (not yet resolved into a
    /// destination) also blocks the restore so its network load is never pre-empted;
    /// the stored ID is kept for a later restore. The caller opens the returned
    /// session through the same import path a tapped row uses, so this never sets
    /// the destination itself.
    public mutating func sessionToRestore(
        from sessions: [SessionSummary],
        allowsAutomaticRestore: Bool = true,
        clearsMissingSelection: Bool = true,
        pendingDeepLinkedSessionID: String? = nil
    ) -> SessionSummary? {
        guard allowsAutomaticRestore,
              destination == nil,
              deepLinkedSessionLoadID == nil,
              Self.normalized(pendingDeepLinkedSessionID) == nil,
              let lastSelectedSessionID
        else { return nil }

        guard let session = sessions.first(where: {
            Self.normalized($0.sessionId) == lastSelectedSessionID
        }) else {
            if clearsMissingSelection {
                self.lastSelectedSessionID = nil
            }
            return nil
        }

        return session
    }

    /// Invalidates both the visible detail and stored restoration target when the
    /// removed session is the selected or most recently selected session.
    public mutating func remove(sessionID: String?) {
        guard let sessionID = Self.normalized(sessionID) else { return }

        if selectedSessionID == sessionID {
            destination = nil
            newChatSessionID = nil
        }

        if lastSelectedSessionID == sessionID {
            lastSelectedSessionID = nil
        }
    }

    private static func normalized(_ sessionID: String?) -> String? {
        guard let sessionID else { return nil }
        let trimmed = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public enum SessionNavigationPersistence {
    private static let keyPrefix = "sessionNavigation.lastSelectedSessionID."

    public static func key(for server: URL) -> String {
        keyPrefix + server.absoluteString
    }

    public static func load(for server: URL, defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: key(for: server))
    }

    public static func save(_ sessionID: String?, for server: URL, defaults: UserDefaults = .standard) {
        let key = key(for: server)
        if let sessionID {
            defaults.set(sessionID, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
