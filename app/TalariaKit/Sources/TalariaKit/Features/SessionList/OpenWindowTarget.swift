import Foundation

/// TAL-2389: a chat or a section opened in its own window from the sidebar, by menu or by dragging the row. One user
/// activity type carries either, and the window it opens reads it when it connects.
public enum OpenWindowTarget: Hashable, Sendable {
    case session(String)
    case section(SessionListUtilityDestination)

    public static let activityType = "dev.kil.talaria.open-window"
    /// The sidebar's destination rows, which open as a window's root.
    static let sections: [SessionListUtilityDestination] = [.tasks, .kanban, .skills, .memory, .insights, .decisions]
    private static let sessionKey = "session"
    private static let sectionKey = "section"

    /// The section row's target, offered only where the device shows several windows.
    public init?(section: SessionListUtilityDestination, supportsMultipleWindows: Bool) {
        guard supportsMultipleWindows, Self.sections.contains(section) else { return nil }
        self = .section(section)
    }

    public init?(userInfo: [AnyHashable: Any]?) {
        if let id = userInfo?[Self.sessionKey] as? String, !id.isEmpty {
            self = .session(id)
        } else if let name = userInfo?[Self.sectionKey] as? String,
                  let section = Self.sections.first(where: { Self.name(of: $0) == name }) {
            self = .section(section)
        } else {
            return nil
        }
    }

    public init?(activity: NSUserActivity) {
        guard activity.activityType == Self.activityType else { return nil }
        self.init(userInfo: activity.userInfo)
    }

    public var userInfo: [String: String] {
        switch self {
        case .session(let id): [Self.sessionKey: id]
        case .section(let section): [Self.sectionKey: Self.name(of: section)]
        }
    }

    /// `title` names the window in the system's window pickers until it sets its own.
    public func activity(title: String) -> NSUserActivity {
        let activity = NSUserActivity(activityType: Self.activityType)
        activity.title = title
        activity.userInfo = userInfo
        return activity
    }

    private static func name(of section: SessionListUtilityDestination) -> String {
        AppSection(section).map { "\($0)" } ?? ""
    }
}
