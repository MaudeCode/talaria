/// Visibility policy for existing actions in the system's vertical toolbar.
public enum ToolbarAction: CaseIterable, Sendable {
    case chatGoal, chatFiles, chatCompanionPage, chatGit, chatMore, chatBackgroundTasks, chatQueuedMessages
    /// The trailing chat of two side by side (TAL-476).
    case chatMakePrimary, chatClose
    case newChat, search, drawer, account, filters, notifications, selectChats, chatsRefresh
    case create, refresh, secondary
    case commit, done, share
    case dismissKeyboard

    public enum Priority: Sendable {
        case highest, high, standard, low
    }

    public var priority: Priority {
        switch self {
        case .newChat, .search, .notifications, .dismissKeyboard: .highest
        case .chatGoal, .chatFiles, .chatCompanionPage, .chatBackgroundTasks, .chatQueuedMessages, .chatMakePrimary, .chatClose, .drawer, .account, .create, .commit, .done: .high
        case .chatGit, .filters, .refresh: .standard
        case .chatMore, .selectChats, .chatsRefresh, .secondary, .share: .low
        }
    }
}
