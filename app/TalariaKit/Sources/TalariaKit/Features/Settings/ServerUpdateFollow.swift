import Foundation

/// How an update started from Settings ended, read from the server's update
/// notification.
public enum ServerUpdateCompletion: Equatable, Sendable {
    case succeeded
    /// Active work blocked the restart; carries the server's explanation.
    case blocked(message: String)
    /// The update failed or its completion could not be verified; carries the
    /// server's explanation.
    case failed(message: String)
    /// The notification is gone (dismissed elsewhere), so there is nothing left to follow.
    case untracked
    /// The server reported no final phase before the timeout.
    case timedOut
}

public extension APIClient {
    /// Polls the update's notification until the server marks it inactive. If the
    /// apply reply was lost, the request's unique tab ID resolves its notification.
    func followUpdate(
        notificationID: String?,
        tabID: String? = nil,
        interval: Duration = .seconds(2),
        timeout: Duration = .seconds(600),
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async -> ServerUpdateCompletion {
        guard notificationID != nil || tabID != nil else { return .untracked }
        var waited = Duration.zero
        while waited < timeout {
            do {
                try await sleep(interval)
            } catch {
                return .timedOut
            }
            waited += interval
            guard let response = try? await updateNotifications(tabID: tabID) else { continue }
            let record: UpdateNotificationRecord?
            if let notificationID {
                record = response.notifications.first { $0.id == notificationID }
                if record == nil { return .untracked }
            } else {
                record = response.tabUpdate
            }
            if let record, !record.active { return record.completion }
        }
        return .timedOut
    }
}

extension UpdateNotificationRecord {
    var completion: ServerUpdateCompletion {
        // `detail` is the apply's own explanation; `message` is the phase's generic wording.
        let explanation = detail.flatMap { $0.isEmpty ? nil : $0 } ?? message
        switch phase {
        case "succeeded": return .succeeded
        case "blocked": return .blocked(message: explanation)
        default: return .failed(message: explanation)
        }
    }
}
