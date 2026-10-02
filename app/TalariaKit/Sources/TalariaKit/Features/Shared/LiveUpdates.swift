public import Foundation
public import SwiftUI

extension Notification.Name {
    /// Posted once each time the app comes back from the background (TAL-435).
    public static let talariaReturnedToForeground = Notification.Name("talariaReturnedToForeground")
    /// Posted for each change the server announces on `/api/sessions/events` (TAL-434). The object
    /// is the server URL; `userInfo[SessionsChange.userInfoKey]` holds the `SessionsChange`.
    public static let talariaSessionsChanged = Notification.Name("talariaSessionsChanged")
}

/// A change the server announced, or a resync after the subscription reconnected and may have
/// missed some.
public enum SessionsChange: Equatable, Sendable {
    case resync
    /// The server coalesces bursts, so `reason` is the latest one and `sessionID` is dropped when
    /// the merged events disagree: treat both as hints.
    case changed(reason: String?, sessionID: String?)

    public static let userInfoKey = "change"
}

/// Which announced changes refresh a screen.
public enum SessionsChangeTrigger: Equatable, Sendable {
    /// Any change to the session list: new, renamed, archived, deleted, a run starting or ending.
    case anyChange
    /// A run ended, so the files, memory, skills or usage it touched may have changed.
    case runEnded
    /// A cron run ended. Scheduled runs announce nothing, so pair this with polling.
    case cronRun
    /// Something that can change one chat's transcript or run state.
    case session(String)

    public func matches(_ change: SessionsChange) -> Bool {
        guard case let .changed(reason, sessionID) = change else { return true }
        switch self {
        case .anyChange:
            return true
        case .runEnded:
            return reason.map(Self.runEndReasons.contains) ?? true
        case .cronRun:
            return reason == "cron_complete"
        case .session(let id):
            if let sessionID { return sessionID == id }
            return reason.map { !Self.listOnlyReasons.contains($0) } ?? true
        }
    }

    private static let runEndReasons: Set<String> = ["session_done", "session_error", "session_cancel", "cron_complete"]
    /// Changes that never touch an open chat's transcript or run.
    private static let listOnlyReasons: Set<String> = [
        "attention_pending", "attention_resolved", "project_create", "project_rename", "project_delete",
        "session_pin", "session_move", "session_share_create", "session_share_revoke", "session_import",
        "cron_complete"
    ]
}

/// Tells a real return from the background apart from an `.inactive` blip such as Control Center
/// or the notification shade. iOS goes `.background` → `.inactive` → `.active`, so the return is
/// the first `.active` after a `.background`.
public struct ForegroundReturnDetector {
    private var wasInBackground = false

    public init() {}

    /// Feeds each scene phase; true exactly once per return from the background.
    public mutating func didReturnToForeground(on phase: ScenePhase) -> Bool {
        switch phase {
        case .background:
            wasInBackground = true
            return false
        case .active:
            defer { wasInBackground = false }
            return wasInBackground
        default:
            return false
        }
    }
}
