import Foundation
import OSLog

private let liveActivityReconcilerLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
    category: "LiveActivityReconciler"
)

// MARK: - Orphaned Live Activity reconciliation (#246)

/// Ends Live Activities left over from a previous app launch whose runs the
/// server reports as no longer active. This closes the "app was terminated while
/// locked, the run finished, and the Live Activity is stuck on running" leak:
/// nothing else reconciles persisted activities the in-memory coordinator never
/// knew about. Streams still active server-side are left untouched for the normal
/// reconnect path to adopt.
@MainActor
enum LiveActivityReconciler {
    /// How recently a run must have completed for the cold-launch reconciler to
    /// still fire a "response complete" notification for it. Matches the 300s
    /// non-stale `staleDate` window the widget uses (#248): an older completion is
    /// finalized silently — the user has long since moved on.
    /// `nonisolated` so it can serve as a default argument (evaluated off the main
    /// actor) without a Swift-6 isolation warning; it's an immutable `Double`.
    nonisolated static let recentCompletionWindow: TimeInterval = 300

    /// The final status + localized widget line a reconciled orphan should be
    /// ended with, derived from the server journal's `terminal_state` (#267).
    struct ReconciledOutcome: Equatable {
        let status: AgentRunActivityStatus
        let activity: String
    }

    /// Maps the server run-journal `terminal_state` to the outcome we finalize a
    /// reconciled orphan with (#267 — owner-decided table on the issue). Reuses
    /// the existing localized completion lines, so there is no new copy.
    ///
    /// The default arm — missing / `"unknown"` / `"running"` / any value we don't
    /// yet recognize — keeps the pre-#267 `.complete` fallback, so an unmapped
    /// state can never mislabel a genuine completion as a failure. Load-bearing
    /// case: the server reports a silently-dropped run (neither active nor
    /// terminal) as `"lost-worker-bookkeeping"`, which must finalize as `.failed`.
    nonisolated static func reconciledOutcome(forTerminalState terminalState: String?) -> ReconciledOutcome {
        switch terminalState {
        case "completed":
            return ReconciledOutcome(status: .complete, activity: String(localized: "Response complete"))
        case "errored", "interrupted-by-crash", "lost-worker-bookkeeping":
            return ReconciledOutcome(status: .failed, activity: String(localized: "Response failed"))
        case "interrupted-by-user":
            return ReconciledOutcome(status: .cancelled, activity: String(localized: "Response cancelled"))
        default:
            return ReconciledOutcome(status: .complete, activity: String(localized: "Response complete"))
        }
    }

    /// The Live Activity end for the turn outcome the server reported (`terminal_state` on a terminal frame or on
    /// the turn's settled scene). A `done` from an older server carries none and completed the turn.
    nonisolated static func outcome(forTurnTerminalState terminalState: String?) -> ReconciledOutcome {
        switch terminalState {
        case nil, "completed", "tool_limit_reached":
            return ReconciledOutcome(status: .complete, activity: String(localized: "Response complete"))
        case "cancelled":
            return ReconciledOutcome(status: .cancelled, activity: String(localized: "Response cancelled"))
        default:
            return ReconciledOutcome(status: .failed, activity: String(localized: "Response failed"))
        }
    }

    /// Production entry point: reconcile every orphaned activity against the
    /// logged-in server's stream status.
    ///
    /// `notifiesOnCompletion` is true only for the cold-launch pass: a relaunched
    /// process means every orphan's run finished while the app was *not* active, so
    /// a recent one is worth a "response complete" notification (#248). The
    /// foreground pass passes false — the in-session completion paths own
    /// notifications while the app is alive, so reconciling there must stay silent.
    static func reconcileOrphanedActivities(
        server: URL,
        notifiesOnCompletion: Bool,
        preferenceEnabled: Bool,
        now: Date = Date(),
        manager: (any AgentLiveActivityManaging)? = nil
    ) async {
        let manager = manager ?? AgentLiveActivityManager.shared
        let orphans = manager.orphanedActivities()
        guard !orphans.isEmpty else { return }
        liveActivityReconcilerLogger.notice("Checking \(orphans.count, privacy: .public) persisted Live Activity(ies) against server status")

        let client = APIClient(baseURL: server)
        await reconcileOrphanedActivities(
            orphans: orphans,
            now: now,
            notifiesOnCompletion: notifiesOnCompletion,
            streamStatus: { streamID in
                try? await client.chatStreamStatus(streamID: streamID)
            },
            endOrphan: { orphan, outcome in
                liveActivityReconcilerLogger.notice("Ending orphaned Live Activity \(orphan.streamID, privacy: .public) — server reports the run is over (\(outcome.status.rawValue, privacy: .public))")
                // #267: finalize each orphan with its real outcome, mapped from the
                // server journal's `terminal_state`, so a run that failed silently
                // or was cancelled no longer shows "Response complete" on the
                // auto-dismissing widget.
                return await manager.endOrphanedActivity(
                    streamID: orphan.streamID,
                    status: outcome.status,
                    activity: outcome.activity
                )
            },
            notify: { orphan in
                liveActivityReconcilerLogger.notice("Notifying response complete for reconciled Live Activity \(orphan.streamID, privacy: .public)")
                // The run completed while the app was *not* active (it was
                // terminated); the recency check in the core stands in for "you
                // weren't watching", so this path always passes sceneIsActive: false.
                // #267: the core only calls `notify` for an orphan that mapped to
                // `.complete`, so this is always a genuine completion — a silently
                // failed run is finalized silently and no longer mis-notifies.
                await ResponseCompletionNotificationService.scheduleResponseCompletedIfAllowed(
                    sessionID: orphan.sessionID.isEmpty ? nil : orphan.sessionID,
                    preferenceEnabled: preferenceEnabled,
                    completedNormally: true,
                    sceneIsActive: false
                )
            }
        )
    }

    /// Testable core. For each orphaned stream, fetch its server status; only a
    /// definitive inactive status (the run is over) ends the activity, finalized
    /// with the outcome mapped from the journal's `terminal_state` (#267). A failed
    /// status check (`nil` response) or a still-active stream is left alone, so a
    /// transient error or a live run can never cut an activity short.
    ///
    /// A "response complete" notification fires only when (a) this is the notifying
    /// (cold-launch) pass, (b) the orphan mapped to `.complete` — a failed or
    /// cancelled run is finalized silently (#267), (c) `endOrphan` reports it
    /// actually ended a still-running activity — so a completion another path
    /// already finalized can't double-fire (#248) — and (d) the run finished within
    /// `recencyWindow`.
    static func reconcileOrphanedActivities(
        orphans: [OrphanedLiveActivity],
        now: Date,
        notifiesOnCompletion: Bool,
        recencyWindow: TimeInterval = recentCompletionWindow,
        streamStatus: (String) async -> ChatStreamStatusResponse?,
        endOrphan: (OrphanedLiveActivity, ReconciledOutcome) async -> Bool,
        notify: (OrphanedLiveActivity) async -> Void
    ) async {
        for orphan in orphans {
            // `active == false` is the only signal that ends the orphan: a `nil`
            // response (check failed) or a missing/`true` `active` flag falls
            // through the guard and leaves the activity untouched.
            guard let status = await streamStatus(orphan.streamID), status.active == false else { continue }
            let outcome = reconciledOutcome(forTerminalState: status.journal?.terminalState)
            let didEnd = await endOrphan(orphan, outcome)
            guard notifiesOnCompletion, didEnd, outcome.status == .complete else { continue }
            let age = now.timeIntervalSince(orphan.updatedAt)
            guard age >= 0, age <= recencyWindow else { continue }
            await notify(orphan)
        }
    }
}
