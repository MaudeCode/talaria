/// Visibility policy for system toolbar actions on either axis.
public enum ToolbarAction: CaseIterable, Sendable {
    case chatGoal, chatFiles, chatGit, chatBackgroundTasks, chatQueuedMessages
    case newChat, drawer, notifications, selectChats, chatsRefresh
    case create, refresh, secondary
    case commit, done, share

    public enum Priority: Sendable {
        case high, standard, low
    }

    public func priority(isVerticalBar: Bool) -> Priority {
        return switch self {
        case .chatBackgroundTasks, .chatQueuedMessages: .high
        case .chatGoal, .chatFiles, .newChat, .drawer, .create, .commit, .done: isVerticalBar ? .high : .standard
        case .chatGit, .notifications, .refresh: .standard
        case .selectChats, .chatsRefresh, .secondary, .share: isVerticalBar ? .low : .standard
        }
    }
}
