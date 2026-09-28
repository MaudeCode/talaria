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
public enum SessionListAutoRefresh {
    /// Modest enough that an idle sidebar is cheap, frequent enough that a
    /// session started elsewhere shows up while the user is still looking.
    static let interval = Duration.seconds(30)

    /// `.task(id:)` restarts the loop whenever this changes. That restart is
    /// also how foregrounding and the list coming back on screen earn their
    /// immediate refresh, instead of waiting out an interval that elapsed while
    /// nothing was polling.
    public struct TaskID: Equatable {
        var server: URL
        var isSceneActive: Bool
        var isListVisible: Bool

        public init(server: URL, isSceneActive: Bool, isListVisible: Bool) {
            self.server = server
            self.isSceneActive = isSceneActive
            self.isListVisible = isListVisible
        }

        public var isEnabled: Bool { isSceneActive && isListVisible }
    }

    /// - Parameters:
    ///   - refreshesImmediately: `false` only for the cold start, where the
    ///     initial-load task already owns the first request.
    ///   - sleep: injectable so tests drive the cadence deterministically. A
    ///     thrown error ends the loop, which is how cancellation exits.
    ///
    /// There is deliberately no in-flight gate here. `SessionListRefreshQueue`
    /// coalesces triggers that reach it, but only those that reach it: dropping
    /// a foreground or return tick early would leave it unrecorded, and the load
    /// already running may predate the very change that tick is reacting to.
    @MainActor
    public static func run(
        refreshesImmediately: Bool,
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

            await refresh()
        }
    }
}

/// Serializes every full-list reload onto one owner.
///
/// `SessionListViewModel` owns the queue and routes `load` through it, so this
/// covers the automatic tick, pull-to-refresh, the return refresh, the
/// active-row monitor and the reloads the view model itself runs after a
/// mutation. There is no reload outside the queue, so a request can never be
/// left with no owner to serve it.
///
/// A trigger arriving while a load is in flight is not discarded: the in-flight
/// request may have been sent before the change the trigger is reacting to — a
/// chat the user just left, a pull after a remote rename — so it is not
/// guaranteed to carry those rows. It records its generation and returns, and
/// the caller already serving runs one follow-up once the current load
/// finishes. Every trigger that arrived during it coalesces into that single
/// follow-up rather than queueing a request each.
///
/// Two rules keep that safe against SwiftUI replacing `.task(id:)` owners, which
/// foregrounding, returning to the compact list and switching sessions all do:
///
/// - A caller that finds another already serving records and returns rather than
///   waiting, so a reload can request another without deadlocking.
/// - Each reload runs in a task this queue owns, and the serving loop drains
///   every outstanding generation without checking for cancellation. Cancelling
///   a caller therefore cannot abandon a reload part-way or strand the request
///   of a caller it replaced.
@MainActor
final class SessionListRefreshQueue {
    private var requestedGeneration = 0
    private var servedGeneration = 0
    private var isServing = false

    /// Records a reload request, then serves it and anything else outstanding
    /// unless another caller is already serving.
    func run(_ refresh: @escaping @MainActor () async -> Void) async {
        requestedGeneration += 1

        guard !isServing else { return }

        isServing = true
        defer { isServing = false }

        while servedGeneration < requestedGeneration {
            // Read before the reload starts: a request arriving while it runs
            // belongs to the next turn of this loop, not to a reload that was
            // already in flight without it.
            let serving = requestedGeneration
            await Task { @MainActor in
                await refresh()
                servedGeneration = serving
            }.value
        }
    }
}
