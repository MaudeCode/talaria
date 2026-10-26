/// Visibility policy for existing actions in the system's vertical toolbar.
public enum ToolbarAction: CaseIterable, Sendable {
    case chatGoal, chatFiles, chatGit, chatMore, chatBackgroundTasks, chatQueuedMessages
    case newChat, search, drawer, account, filters, notifications, selectChats, chatsRefresh
    case create, refresh, secondary
    case commit, done, share

    public enum Priority: Sendable {
        case highest, high, standard, low
    }

    public var priority: Priority {
        switch self {
        case .newChat, .search, .notifications: .highest
        case .chatGoal, .chatFiles, .chatBackgroundTasks, .chatQueuedMessages, .drawer, .account, .create, .commit, .done: .high
        case .chatGit, .filters, .refresh: .standard
        case .chatMore, .selectChats, .chatsRefresh, .secondary, .share: .low
        }
    }
}
