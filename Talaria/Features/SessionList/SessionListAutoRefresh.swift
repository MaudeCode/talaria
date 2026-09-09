import Foundation

/// Keeps the Chats list current while it is on screen, so sessions created or
/// changed by another client, a scheduled run, or a webhook appear without a
/// manual pull-to-refresh.
///
/// This is the only polling loop for the full session list. Every other
/// freshness trigger — initial load, pull-to-refresh, the return refresh, and
/// this loop's own foreground tick — calls the view's single
/// `refreshSessionsAndActiveProfile()`, which drops a trigger while a list load
/// is already in flight. That guard is the shared deduplication owner, so no two
/// equivalent full-list requests overlap.
enum SessionListAutoRefresh {
    /// Modest enough that an idle sidebar is cheap, frequent enough that a
    /// session started elsewhere shows up while the user is still looking.
    static let interval = Duration.seconds(30)

    /// `.task(id:)` restarts the loop whenever this changes. That restart is
    /// also how foregrounding and the list coming back on screen earn their
    /// immediate refresh, instead of waiting out an interval that elapsed while
    /// nothing was polling.
    struct TaskID: Equatable {
        var server: URL
        var isSceneActive: Bool
        var isListVisible: Bool

        var isEnabled: Bool { isSceneActive && isListVisible }
    }

    /// - Parameters:
    ///   - refreshesImmediately: `false` only for the cold start, where the
    ///     initial-load task already owns the first request.
    ///   - isRefreshInFlight: the deduplication gate. A tick that would race an
    ///     in-flight load is dropped rather than queued: the load already
    ///     running delivers the same fresh list.
    ///   - sleep: injectable so tests drive the cadence deterministically. A
    ///     thrown error ends the loop, which is how cancellation exits.
    @MainActor
    static func run(
        refreshesImmediately: Bool,
        isRefreshInFlight: () -> Bool,
        refresh: () async -> Void,
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async {
        var waitsBeforeRefreshing = !refreshesImmediately

        while !Task.isCancelled {
            if waitsBeforeRefreshing {
                do {
                    try await sleep(interval)
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
            }
            waitsBeforeRefreshing = true

            guard !isRefreshInFlight() else { continue }
            await refresh()
        }
    }
}

/// Serializes the full-list refresh triggers that share one owner.
///
/// A trigger arriving while a load is in flight is not discarded: the in-flight
/// request may have been sent before the change the trigger is reacting to — a
/// chat the user just left, a pull after a remote rename — so it is not
/// guaranteed to carry those rows. One follow-up refresh runs after the current
/// load instead, and every trigger that arrived during it coalesces into that
/// single follow-up rather than queueing a request each.
@MainActor
final class SessionListRefreshQueue {
    private var hasFollowUp = false

    /// - Parameter isRefreshInFlight: whether a full-list load this queue does
    ///   not own is already running. The active-row monitor reloads the list on
    ///   its own 1s cadence, so its request is the one case where the follow-up
    ///   flag can outlive the loop that would drain it; the next trigger then
    ///   consumes it as a plain refresh.
    func run(
        isRefreshInFlight: () -> Bool,
        refresh: () async -> Void
    ) async {
        guard !isRefreshInFlight() else {
            hasFollowUp = true
            return
        }

        repeat {
            hasFollowUp = false
            await refresh()
            guard !Task.isCancelled else { return }
        } while hasFollowUp
    }
}
