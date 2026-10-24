/// Visibility policy for existing actions in the system's vertical toolbar.
public enum ToolbarAction: CaseIterable, Sendable {
    case chatGoal, chatFiles, chatGit
    case newChat, search, drawer, account, filters, notifications, selectChats, chatsRefresh
    case create, refresh, secondary
    case commit, done, share

    public enum Priority: Sendable {
        case highest, high, standard, low
    }

    public var priority: Priority {
        switch self {
        case .newChat, .search: .highest
        case .chatGoal, .chatFiles, .drawer, .account, .notifications, .create, .commit, .done: .high
        case .chatGit, .filters, .refresh: .standard
        case .selectChats, .chatsRefresh, .secondary, .share: .low
        }
    }
}
