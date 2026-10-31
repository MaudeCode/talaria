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
    public static let interval = Duration.seconds(30)

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
        interval: Duration = SessionListAutoRefresh.interval,
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

extension SessionListAutoRefresh {
    /// The server's `sessions_changed` event already announces a run's end (TAL-1240), so the per-row status read
    /// is only the fallback for a dropped events stream: one read per streaming row per interval.
    static let activeRowInterval = Duration.seconds(10)

    /// Whether the list's rows are on screen, for both polling loops: a shown sidebar column (only a tiled layout has
    /// one), an open drawer or overlay sidebar, or a destination that shows the list's own rows. Every other root, the
    /// empty chat included, covers it.
    public static func isListVisible(
        sidebar: SidebarPresentation,
        drawerIsPresented: Bool,
        destination: SessionNavigationDestination?
    ) -> Bool {
        sidebar.showsColumn
            || drawerIsPresented
            || destination?.showsSessionListRows == true
    }

    /// `.task(id:)` for the active-row monitor: the list's streaming rows and what gates asking about them.
    public struct ActiveRowTaskID: Hashable {
        public var streamIDs: [String]
        public var hasActiveRows: Bool
        public var isViewingCachedData: Bool
        public var isEventStreamLive: Bool
        public var isListVisible: Bool
        public var isSceneActive: Bool

        public init(
            streamIDs: [String],
            hasActiveRows: Bool,
            isViewingCachedData: Bool,
            isEventStreamLive: Bool,
            isListVisible: Bool,
            isSceneActive: Bool
        ) {
            self.streamIDs = streamIDs
            self.hasActiveRows = hasActiveRows
            self.isViewingCachedData = isViewingCachedData
            self.isEventStreamLive = isEventStreamLive
            self.isListVisible = isListVisible
            self.isSceneActive = isSceneActive
        }

        /// A live events stream suspends the monitor; its end changes the id and restarts it. The open chat follows
        /// its own run, so a hidden list or an inactive app asks nothing (TAL-840).
        public var isEnabled: Bool {
            hasActiveRows && !isViewingCachedData && !isEventStreamLive && isOnScreen
        }

        var isOnScreen: Bool { isListVisible && isSceneActive }
    }

    /// Asks after the streaming rows every `activeRowInterval` while `taskID` is enabled. A run can end while the list
    /// is hidden or the app inactive, so coming back from either checks once before the first wait.
    @MainActor
    public static func monitorActiveRows(
        _ taskID: ActiveRowTaskID,
        resumingFrom previous: ActiveRowTaskID? = nil,
        check: () async -> Void,
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async {
        guard taskID.isEnabled else { return }
        let returnsOnScreen = previous.map { !$0.isOnScreen } ?? false
        await run(refreshesImmediately: returnsOnScreen, interval: activeRowInterval, refresh: check, sleep: sleep)
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
