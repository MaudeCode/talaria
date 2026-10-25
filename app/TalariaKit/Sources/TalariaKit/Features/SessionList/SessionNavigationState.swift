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

    /// Scheduled and webhook lists show the session list's own rows, so the list keeps polling
    /// while they are on screen (TAL-434).
    public var showsSessionListRows: Bool {
        switch self {
        case .utility(.scheduled), .utility(.webhook):
            return true
        default:
            return false
        }
    }
}

public struct SessionNavigationState: Equatable {
    public private(set) var destination: SessionNavigationDestination? {
        // The chat a destination opens reports its own Files inspector and companion page when it appears.
        didSet {
            launchRestoreResolved = true
            filesInspectorPresented = false
            chatShowsFilesInspector = false
            chatShowsCompanionPage = false
        }
    }
    /// Explicit Files presentation for the current chat, cleared on navigation or layout dismissal.
    public var filesInspectorPresented = false
    /// Whether the open chat shows its Files inspector, which can hide the regular-width sidebar column to make room
    /// (TAL-1453).
    public var chatShowsFilesInspector = false
    /// Whether the open chat has a companion page to show beside it, which can hide the regular-width sidebar column
    /// to make room (TAL-1458).
    public var chatShowsCompanionPage = false
    public private(set) var lastSelectedSessionID: String?
    /// Consumed synchronously from local summaries before a launch root is displayed, including a cache miss.
    public private(set) var launchRestoreResolved = false
    public private(set) var rootRevision = 0
    /// Changes only when a chat root is replaced or cleared.
    public private(set) var chatRootRevision = 0
    public var selectedSectionSession: SessionSummary? {
        didSet {
            if selectedSectionSession?.sessionId != oldValue?.sessionId { filesInspectorPresented = false }
        }
    }
    /// The current root; the sidebar always remains the Chats panel.
    public private(set) var section = AppSection.chats {
        didSet {
            // Inner pages belong to their section root.
            guard section != oldValue else { return }
            selectedItem = nil
        }
    }
    /// The current section's pushed item, kept outside both layouts so folding preserves the path.
    public var selectedItem: SectionItem? {
        didSet {
            guard selectedItem != oldValue else { return }
            selectedSectionSession = nil
        }
    }
    private var newChatSessionID: String?
    private var deepLinkedSessionLoadID: String?
    private var startedOpens = 0

    /// Advances with every navigation and with every session open that starts
    /// resolving, so an open still loading or importing yields to anything newer —
    /// including a row tap whose own import has not landed yet (TAL-153).
    public var openRevision: Int {
        rootRevision + startedOpens
    }

    public init(lastSelectedSessionID: String? = nil) {
        self.lastSelectedSessionID = Self.normalized(lastSelectedSessionID)
    }

    public var selectedSessionID: String? {
        destination?.selectedSessionID ?? newChatSessionID
    }

    /// Selecting a chat replaces the root and clears its inner pages.
    public mutating func select(_ session: SessionSummary) {
        rootRevision += 1
        chatRootRevision += 1
        selectedSectionSession = nil
        newChatSessionID = nil
        destination = .session(session)
        section = .chats
        remember(session)
    }

    public mutating func select(_ route: PendingNewChatRoute) {
        rootRevision += 1
        chatRootRevision += 1
        selectedSectionSession = nil
        newChatSessionID = nil
        destination = .newChat(route)
        section = .chats
    }

    /// Entering a section replaces the root and clears its inner pages.
    public mutating func select(_ utility: SessionListUtilityDestination) {
        guard let root = AppSection(utility) else { return }
        rootRevision += 1
        newChatSessionID = nil
        destination = .utility(utility)
        section = root
        selectedSectionSession = nil
        selectedItem = nil
    }

    public mutating func pushSectionSession(_ session: SessionSummary) {
        rootRevision += 1
        selectedSectionSession = session
        remember(session)
    }

    public mutating func remember(_ session: SessionSummary) {
        guard let sessionID = Self.normalized(session.sessionId) else { return }
        lastSelectedSessionID = sessionID
        switch destination {
        case nil, .newChat: newChatSessionID = sessionID
        default: break
        }
    }

    /// Advances `rootRevision` like the `select` overloads: clearing the
    /// destination is a navigation the user chose, so work still resolving for the
    /// destination it replaces must not reinstate it.
    public mutating func clearDestination() {
        rootRevision += 1
        selectedSectionSession = nil
        chatRootRevision += 1
        destination = nil
        newChatSessionID = nil
        selectedItem = nil
        section = .chats
    }

    /// Starts a session open and returns the `openRevision` it stays current at.
    public mutating func beginOpen() -> Int {
        startedOpens += 1
        return openRevision
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

    /// Consumes the launch-only restore decision from local summaries. A miss or an explicit route settles it too;
    /// later network rows must never replace the root already on screen. The caller installs a hit synchronously.
    public mutating func sessionToRestore(
        from sessions: [SessionSummary],
        allowsAutomaticRestore: Bool = true,
        clearsMissingSelection: Bool = true,
        pendingDeepLinkedSessionID: String? = nil
    ) -> SessionSummary? {
        guard !launchRestoreResolved else { return nil }
        launchRestoreResolved = true
        guard allowsAutomaticRestore,
              destination == nil,
              startedOpens == 0,
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

        if selectedSectionSession?.sessionId == sessionID { selectedSectionSession = nil }
        if destination?.selectedSessionID == sessionID || newChatSessionID == sessionID {
            chatRootRevision += 1
            destination = nil
            section = .chats
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
