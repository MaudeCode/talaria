/// Visibility policy for existing actions in the system's vertical toolbar.
public enum ToolbarAction: CaseIterable, Sendable {
    case chatGoal, chatFiles, chatGit, chatBackgroundTasks, chatQueuedMessages
    case newChat, drawer, notifications, selectChats, chatsRefresh
    case create, refresh, secondary
    case commit, done, share

    public enum Priority: Sendable {
        case high, standard, low
    }

    public var priority: Priority {
        switch self {
        case .chatGoal, .chatFiles, .chatBackgroundTasks, .chatQueuedMessages, .newChat, .drawer, .create, .commit, .done: .high
        case .chatGit, .notifications, .refresh: .standard
        case .selectChats, .chatsRefresh, .secondary, .share: .low
        }
    }
}
