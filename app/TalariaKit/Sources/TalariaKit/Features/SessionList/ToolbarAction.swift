/// Visibility policy for existing actions in the system's vertical toolbar.
public enum ToolbarAction: CaseIterable, Sendable {
    case chatGoal, chatFiles, chatGit
    case newChat, drawer, account, filters, notifications, selectChats, chatsRefresh
    case create, refresh, secondary
    case commit, done, share

    public enum Priority: Sendable {
        case high, standard, low
    }

    public var priority: Priority {
        switch self {
        case .chatGoal, .chatFiles, .newChat, .drawer, .account, .create, .commit, .done: .high
        case .chatGit, .filters, .refresh: .standard
        case .notifications, .selectChats, .chatsRefresh, .secondary, .share: .low
        }
    }
}
