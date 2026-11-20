import Foundation

/// Marker rows the agent writes around context compaction. The server classifies
/// them and stamps `_marker_kind` (TAL-305); the app only renders that field.
public enum ChatMarkerMessageKind: Equatable, Sendable {
    case contextCompaction
    case preservedTaskList
    /// TAL-2058: an ask the provider's safety filter refused, kept on screen and out of model history, with the server's
    /// `_refused_notice` (the Agent's own copy, possibly empty).
    case contentRefused(notice: String)

    /// The server's `_marker_kind`; an unknown kind renders as an ordinary message.
    init?(wireValue: String?, refusedNotice: String? = nil) {
        switch wireValue {
        case "context_compaction": self = .contextCompaction
        case "preserved_task_list": self = .preservedTaskList
        case "content_refused": self = .contentRefused(notice: refusedNotice ?? "")
        default: return nil
        }
    }

    var wireValue: String {
        switch self {
        case .contextCompaction: "context_compaction"
        case .preservedTaskList: "preserved_task_list"
        case .contentRefused: "content_refused"
        }
    }

    var refusedNotice: String? {
        if case .contentRefused(let notice) = self { notice } else { nil }
    }

    public var title: String {
        switch self {
        case .contextCompaction:
            return String(localized: "Context compaction")
        case .preservedTaskList:
            return String(localized: "Preserved task list")
        case .contentRefused(let notice):
            return notice
        }
    }
}
