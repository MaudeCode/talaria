import Foundation
import OSLog
import TalariaKit

private let liveActivityReconcilerLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
    category: "LiveActivityReconciler"
)

extension LiveActivityReconciler {
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
}
