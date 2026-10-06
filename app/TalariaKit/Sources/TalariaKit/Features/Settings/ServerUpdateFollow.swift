import Foundation

/// How an update started from Settings ended, read from the server's update
/// notification (`notification_id` on the apply response).
public enum ServerUpdateCompletion: Equatable {
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
    /// Polls the update's notification until the server marks it inactive. The
    /// server drops connections while it restarts, so a failed poll keeps waiting.
    func followUpdate(
        notificationID: String,
        interval: Duration = .seconds(2),
        timeout: Duration = .seconds(600),
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async -> ServerUpdateCompletion {
        var waited = Duration.zero
        while waited < timeout {
            do {
                try await sleep(interval)
            } catch {
                return .timedOut
            }
            waited += interval
            guard let response = try? await updateNotifications() else { continue }
            guard let record = response.notifications.first(where: { $0.id == notificationID }) else {
                return .untracked
            }
            if !record.active { return record.completion }
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
