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
    private var isRunning = false
    private var hasFollowUp = false

    /// - Parameter isRefreshInFlight: whether a full-list load this queue does
    ///   not own is already running. The active-row monitor reloads the list
    ///   through `refreshActiveSessionStatesIfNeeded`, which is the one such
    ///   owner; it calls `drainFollowUp` afterwards to run anything deferred
    ///   during it.
    func run(
        isRefreshInFlight: () -> Bool,
        refresh: () async -> Void
    ) async {
        // `isRunning` spans the whole closure, not just its session request. A
        // refresh also reloads projects and the active profile after that
        // request settles, and those have no generation fence of their own, so
        // a second owner starting there could let an older response overwrite
        // newer project state.
        guard !isRunning, !isRefreshInFlight() else {
            hasFollowUp = true
            return
        }

        isRunning = true
        defer { isRunning = false }

        repeat {
            hasFollowUp = false
            await refresh()
            if Task.isCancelled {
                // This load was cancelled part-way, so whatever it was standing
                // in for is still outstanding. Keep the follow-up for the next
                // owner instead of consuming it here.
                hasFollowUp = true
                return
            }
        } while hasFollowUp
    }

    /// Runs the follow-up left behind by a load this queue does not own.
    ///
    /// `run` drains its own follow-ups, but the active-row monitor reloads the
    /// list through `refreshActiveSessionStatesIfNeeded`, so a trigger arriving
    /// during that reload has no loop waiting to pick it up. The monitor calls
    /// this once its reload finishes so the deferred refresh still happens
    /// promptly instead of waiting for the next tick.
    func drainFollowUp(refresh: () async -> Void) async {
        guard hasFollowUp else { return }
        await run(isRefreshInFlight: { false }, refresh: refresh)
    }
}
