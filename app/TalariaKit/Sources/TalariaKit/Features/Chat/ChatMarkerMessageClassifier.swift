import Foundation

/// Marker rows the agent writes around context compaction. The server classifies
/// them and stamps `_marker_kind` (TAL-305); the app only renders that field.
public enum ChatMarkerMessageKind: Equatable {
    case contextCompaction
    case preservedTaskList
    /// Synthesized "Context compaction · Reference only" anchor card built from
    /// session-level `compression_anchor_*` metadata — never sent as a
    /// `_marker_kind`.
    case compressionReference

    /// The server's `_marker_kind`; an unknown kind renders as an ordinary message.
    init?(wireValue: String?) {
        switch wireValue {
        case "context_compaction": self = .contextCompaction
        case "preserved_task_list": self = .preservedTaskList
        default: return nil
        }
    }

    var wireValue: String? {
        switch self {
        case .contextCompaction: "context_compaction"
        case .preservedTaskList: "preserved_task_list"
        case .compressionReference: nil
        }
    }

    public var title: String {
        switch self {
        case .contextCompaction, .compressionReference:
            return String(localized: "Context compaction")
        case .preservedTaskList:
            return String(localized: "Preserved task list")
        }
    }
}
