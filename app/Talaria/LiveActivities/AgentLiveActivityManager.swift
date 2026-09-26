import ActivityKit
import Foundation

enum AgentLiveActivityEvent: Equatable {
    case sessionTitle(String)
    case token(String)
    case interimAssistant(String)
    case clearResponseExcerpt
    case reasoning(String)
    case toolStarted(kind: ToolDisplayKind?, name: String?)
    case toolCompleted
    case waitingForApproval
    case waitingForClarification
}

/// A persisted Live Activity left over from a previous launch that this manager
/// isn't currently driving — a reconciliation candidate (#246). Carries the bits
/// the reconciler needs to decide whether a "response complete" notification is
/// still worth firing: the run's session and when it last advanced (#248).
struct OrphanedLiveActivity: Equatable {
    let streamID: String
    let sessionID: String
    let updatedAt: Date
}

@MainActor
protocol AgentLiveActivityManaging: AnyObject {
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL)
    /// `startedAt` is when the run began, not when the widget was created: the
    /// coordinator passes the server-seeded run start so the widget's elapsed
    /// timer counts the whole turn rather than from this process attaching.
    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date)
    func update(_ event: AgentLiveActivityEvent)
    func markStale()
    func end(status: AgentRunActivityStatus, activity: String, errorSummary: String?)
    /// Persisted Live Activities left over from a previous launch that this manager
    /// isn't currently driving — reconciliation candidates (#246).
    func orphanedActivities() -> [OrphanedLiveActivity]
    /// End a persisted activity this manager isn't tracking in memory (e.g. the
    /// app was terminated mid-run and relaunched), matched by streamID (#246).
    /// Returns `true` only if it actually transitioned a still-running activity to
    /// final — the reconciler uses that to avoid firing a duplicate notification
    /// for a completion another path already finalized (#248).
    @discardableResult
    func endOrphanedActivity(streamID: String, status: AgentRunActivityStatus, activity: String) async -> Bool
}

extension AgentLiveActivityManaging {
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {}
    // Defaults so test spies and non-ActivityKit conformers don't have to care
    // about reconciliation; the real manager overrides both.
    func orphanedActivities() -> [OrphanedLiveActivity] { [] }
    @discardableResult
    func endOrphanedActivity(streamID: String, status: AgentRunActivityStatus, activity: String) async -> Bool { false }
}

@MainActor
final class AgentLiveActivityManager: AgentLiveActivityManaging {
    static let shared = AgentLiveActivityManager()

    private let minimumUpdateInterval: TimeInterval
    private var activity: Activity<AgentRunActivityAttributes>?
    private(set) var currentState: AgentRunActivityAttributes.ContentState?
    private var currentSessionID: String?
    private var currentStreamID: String?
    private var currentPublisherURL: URL?
    // StreamID of the run whose SSE is live in THIS process right now: set when the
    // coordinator (re)connects (`start`), cleared the moment it suspends/hits trouble
    // (`markStale`) or finalizes (`end`/`reset`). The orphan reconciler skips it so a
    // server status poll that briefly reports "inactive" — the window between the
    // server finishing and the on-device `.done` arriving — can't finalize a stream
    // the foreground coordinator still owns. A terminated run starts from a fresh
    // singleton (nothing tracked), so the #246 orphan fix is unaffected. (PR #266 #3)
    private(set) var activeConnectedStreamID: String?
    private var rawResponseText = ""
    private var lastSentUpdateAt: Date?
    private var pendingUpdateTask: Task<Void, Never>?
    private var updateGeneration = 0
    private var lifecycleGeneration = 0
    private let relayRegistration = PerSessionRelayActivityRegistration()

    init(minimumUpdateInterval: TimeInterval = 1.5) {
        self.minimumUpdateInterval = minimumUpdateInterval
    }

    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {
        TalariaAggregateLiveActivityManager.shared.armForLocalWork(
            sessionID: sessionID,
            sessionTitle: sessionTitle,
            publisherURL: publisherURL
        )
    }

    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date = Date()) {
        let normalizedSessionID = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSessionID.isEmpty else { return }
        let normalizedStreamID = AgentLiveActivityReusePolicy.normalizedStreamID(streamID)
        currentPublisherURL = TalariaRelayClient.originURL(publisherURL)
        // A live SSE connection now owns this stream's completion (PR #266 #3).
        activeConnectedStreamID = normalizedStreamID

        if currentSessionID == normalizedSessionID,
           currentStreamID == normalizedStreamID,
           currentState?.isFinal == false {
            updateCurrentState { state in
                AgentRunActivityAttributes.ContentState(
                    sessionID: state.sessionID,
                    sessionTitle: state.sessionTitle,
                    status: state.status,
                    currentActivity: state.currentActivity,
                    responseExcerpt: state.responseExcerpt,
                    // Earliest known start wins: the reused activity may have
                    // started from a discovery stamp before the coordinator
                    // learned the server's earlier `pending_started_at`.
                    startedAt: min(state.startedAt, startedAt),
                    updatedAt: Date(),
                    isStale: false,
                    isFinal: false,
                    errorSummary: nil
                )
            }
            return
        }

        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
        relayRegistration.cancelObservation()
        rawResponseText = ""
        currentSessionID = normalizedSessionID
        currentStreamID = normalizedStreamID
        let state = AgentRunActivityStateReducer.initialState(
            sessionID: normalizedSessionID,
            sessionTitle: sessionTitle,
            startedAt: startedAt,
            updatedAt: Date()
        )
        currentState = state
        lastSentUpdateAt = nil
        let lifecycle = nextLifecycleGeneration()
        _ = nextUpdateGeneration()

        guard TalariaLiveActivityMode.current == .perSession else {
            activity = nil
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            activity = nil
            return
        }

        let publisherURL = currentPublisherURL
        Task { [weak self, lifecycle, publisherURL] in
            await self?.requestOrUpdateActivity(
                sessionID: normalizedSessionID,
                streamID: normalizedStreamID,
                sessionTitle: state.sessionTitle,
                state: state,
                lifecycle: lifecycle,
                publisherURL: publisherURL
            )
        }
    }

    func refreshForCurrentMode() async {
        switch TalariaLiveActivityMode.current {
        case .allRunning:
            pendingUpdateTask?.cancel()
            pendingUpdateTask = nil
            _ = nextLifecycleGeneration()
            _ = nextUpdateGeneration()
            let endingActivity = activity
            activity = nil
            if let endingActivity, !AgentLiveActivityReusePolicy.preservesCompletedActivity(
                isFinal: endingActivity.content.state.isFinal,
                relayPublisherID: endingActivity.attributes.relayPublisherID
            ) {
                await endingActivity.end(nil, dismissalPolicy: .immediate)
                unregisterRelayInBackground(
                    activityID: endingActivity.id,
                    fallbackCredentials: TalariaRelayConfigurationStore.load()
                )
            }
        case .perSession:
            guard let state = currentState,
                  !state.isFinal,
                  let currentSessionID else { return }
            let lifecycle = nextLifecycleGeneration()
            await requestOrUpdateActivity(
                sessionID: currentSessionID,
                streamID: currentStreamID,
                sessionTitle: state.sessionTitle,
                state: state,
                lifecycle: lifecycle,
                publisherURL: currentPublisherURL
            )
        }
    }

    func disconnectRelayRegistration(preserveCompleted: Bool = false) async {
        let credentials = TalariaRelayConfigurationStore.load()
        for retained in Activity<AgentRunActivityAttributes>.activities where retained.attributes.relayPublisherID != nil {
            if preserveCompleted && retained.content.state.isFinal { continue }
            await retained.end(nil, dismissalPolicy: .immediate)
            await relayRegistration.unregister(activityID: retained.id, fallbackCredentials: credentials)
        }
        if let activityID = relayRegistration.activityID {
            await relayRegistration.unregister(activityID: activityID)
        } else {
            relayRegistration.reset()
        }
    }

    func update(_ event: AgentLiveActivityEvent) {
        guard currentState != nil else { return }

        switch event {
        case .sessionTitle(let title):
            updateCurrentState { state in
                AgentRunActivityStateReducer.updatingSessionTitle(title, state: state)
            }
        case .token(let text):
            guard !text.isEmpty else { return }
            rawResponseText += text
            updateCurrentState(immediate: false) { state in
                AgentRunActivityStateReducer.settingInterimAssistant(rawResponseText, on: state)
            }
        case .interimAssistant(let text):
            let excerpt = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !excerpt.isEmpty else { return }
            rawResponseText = rawResponseText.isEmpty ? excerpt : rawResponseText
            updateCurrentState { state in
                AgentRunActivityStateReducer.settingInterimAssistant(excerpt, on: state)
            }
        case .clearResponseExcerpt:
            rawResponseText = ""
            updateCurrentState { state in
                AgentRunActivityStateReducer.clearingResponseExcerpt(state: state)
            }
        case .reasoning(let text):
            updateCurrentState { state in
                AgentRunActivityStateReducer.reasoning(text, state: state)
            }
        case .toolStarted(let kind, let name):
            updateCurrentState { state in
                AgentRunActivityStateReducer.toolStarted(kind: kind, name: name, state: state)
            }
        case .toolCompleted:
            updateCurrentState { state in
                AgentRunActivityStateReducer.toolCompleted(state: state)
            }
        case .waitingForApproval:
            updateCurrentState { state in
                AgentRunActivityStateReducer.waitingForApproval(state: state)
            }
        case .waitingForClarification:
            updateCurrentState { state in
                AgentRunActivityStateReducer.waitingForClarification(state: state)
            }
        }
    }

    func markStale() {
        // Suspended / troubled: the live SSE no longer owns completion, so the
        // stream is eligible for server-truth reconciliation again (PR #266 #3).
        activeConnectedStreamID = nil
        guard currentState?.isFinal == false else { return }

        updateCurrentState { state in
            AgentRunActivityStateReducer.stale(state: state)
        }
    }

    func end(status: AgentRunActivityStatus, activity activityLine: String, errorSummary: String? = nil) {
        // The run is finalizing — drop the live-connection claim (PR #266 #3).
        activeConnectedStreamID = nil
        guard let currentState else { return }

        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil

        let finalState = AgentRunActivityStateReducer.final(
            status: status,
            activity: activityLine,
            state: currentState,
            errorSummary: errorSummary
        )
        self.currentState = finalState
        let endingActivity = activity
        let endingSessionID = currentSessionID
        let lifecycle = nextLifecycleGeneration()
        _ = nextUpdateGeneration()
        activity = nil

        Task { [weak self, endingActivity, lifecycle] in
            await self?.endActivity(
                endingActivity,
                with: finalState,
                status: status,
                endingSessionID: endingSessionID,
                lifecycle: lifecycle
            )
        }
    }

    func orphanedActivities() -> [OrphanedLiveActivity] {
        let all = Activity<AgentRunActivityAttributes>.activities
        // Every non-final persisted activity is a candidate. We deliberately do
        // NOT exclude `currentStreamID` here: that in-memory flag goes stale when
        // a run ends without the manager being told (e.g. the app froze in the
        // background and came back with the stream untracked), which left the
        // activity stuck on "running" with nothing to finalize it (#246). The
        // caller gates purely on the server's status instead, which is ground
        // truth — a genuinely live run reports active=true and is left alone.
        let result: [OrphanedLiveActivity] = all.compactMap { activity in
            guard let streamID = AgentLiveActivityReusePolicy.normalizedStreamID(activity.attributes.streamID) else {
                return nil
            }
            let state = activity.content.state
            guard state.isFinal == false else { return nil }
            // Skip a stream whose SSE is live in this process right now: the
            // foreground coordinator owns its completion and a transient server
            // "inactive" must not let us finalize it early (mirrors the
            // refreshTranscriptIfCompleted safety net). Cleared on suspend/end, so
            // a genuinely stuck orphan is never excluded here. (PR #266 #3)
            guard streamID != activeConnectedStreamID else { return nil }
            return OrphanedLiveActivity(
                streamID: streamID,
                sessionID: state.sessionID,
                updatedAt: state.updatedAt
            )
        }
        return result
    }

    @discardableResult
    func endOrphanedActivity(
        streamID: String,
        status: AgentRunActivityStatus,
        activity activityLine: String
    ) async -> Bool {
        guard let normalized = AgentLiveActivityReusePolicy.normalizedStreamID(streamID) else { return false }

        var didEndRunningActivity = false
        for persisted in Activity<AgentRunActivityAttributes>.activities
        where AgentLiveActivityReusePolicy.normalizedStreamID(persisted.attributes.streamID) == normalized {
            guard persisted.content.state.isFinal == false else { continue }

            let finalState = AgentRunActivityStateReducer.final(
                status: status,
                activity: activityLine,
                state: persisted.content.state
            )
            let fallbackCredentials = TalariaRelayConfigurationStore.load()
            if AgentLiveActivityReusePolicy.preservesCompletedActivity(
                isFinal: finalState.isFinal, relayPublisherID: persisted.attributes.relayPublisherID
            ) {
                await persisted.update(ActivityContent(state: finalState, staleDate: nil))
                didEndRunningActivity = true
                continue
            }
            // `end(content:)` sets the final content directly and there is no
            // intervening render delay here, so a preceding `update` is redundant
            // (PR #266 review).
            await persisted.end(
                ActivityContent(state: finalState, staleDate: nil),
                dismissalPolicy: dismissalPolicy(for: status)
            )
            unregisterRelayInBackground(
                activityID: persisted.id,
                fallbackCredentials: fallbackCredentials
            )
            didEndRunningActivity = true
        }

        // Clear stale in-memory tracking if this was the stream the manager still
        // thought it was driving, so a new run in the same session starts clean.
        if normalized == currentStreamID {
            reset()
        }

        return didEndRunningActivity
    }

    func reconcileAcknowledgedCompletions(
        _ completions: [TalariaRelayClient.Completion], credentials: TalariaRelayCredentials,
        viewedPublisherURL: URL, viewedSessionID: String, through viewedAt: Date
    ) async {
        guard let publisherID = TalariaRelayClient.originURL(viewedPublisherURL)?.absoluteString else { return }
        for activity in Activity<AgentRunActivityAttributes>.activities {
            guard TalariaRelayConfigurationStore.load() == credentials else { return }
            let matches = completions.contains { completion in
                completion.row.publisherId == activity.attributes.relayPublisherID
                    && completion.row.sessionId == activity.attributes.sessionID
                    && completion.row.streamId != nil
                    && completion.row.streamId == activity.attributes.streamID
            }
            let viewedCompletion = AgentLiveActivityReusePolicy.isViewedCompletion(
                state: activity.content.state, publisherID: activity.attributes.relayPublisherID,
                viewedPublisherID: publisherID, viewedSessionID: viewedSessionID, through: viewedAt
            )
            guard matches || viewedCompletion else { continue }
            await activity.end(nil, dismissalPolicy: .immediate)
            let tracksCompletedStream = activity.attributes.streamID != nil
                && currentStreamID == activity.attributes.streamID
                && currentSessionID == activity.attributes.sessionID
                && currentPublisherURL?.absoluteString == activity.attributes.relayPublisherID
            if self.activity?.id == activity.id || tracksCompletedStream { reset() }
            await relayRegistration.unregister(activityID: activity.id, fallbackCredentials: credentials)
        }
    }
}

private extension AgentLiveActivityManager {
    private func requestOrUpdateActivity(
        sessionID: String,
        streamID: String?,
        sessionTitle: String,
        state: AgentRunActivityAttributes.ContentState,
        lifecycle: Int,
        publisherURL: URL?
    ) async {
        guard lifecycle == lifecycleGeneration else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            return
        }

        do {
            let relayContext = PerSessionRelayContext.make(for: publisherURL)
            let existingActivities = Activity<AgentRunActivityAttributes>.activities
            let reusableActivity = existingActivities.first { existing in
                !existing.content.state.isFinal && AgentLiveActivityReusePolicy.canReuseActivity(
                    existingSessionID: existing.attributes.sessionID,
                    existingStreamID: existing.attributes.streamID,
                    requestedSessionID: sessionID,
                    requestedStreamID: streamID
                )
                    && (
                        relayContext == nil
                            || existing.attributes.relayPublisherID == relayContext?.publisherID
                            || existing.id == relayRegistration.activityID
                    )
            }

            for staleActivity in existingActivities {
                if let reusableActivity, staleActivity.id == reusableActivity.id {
                    continue
                }

                if AgentLiveActivityReusePolicy.preservesCompletedActivity(
                    isFinal: staleActivity.content.state.isFinal,
                    relayPublisherID: staleActivity.attributes.relayPublisherID
                ) { continue }
                await staleActivity.end(nil, dismissalPolicy: .immediate)
                unregisterRelayInBackground(
                    activityID: staleActivity.id,
                    fallbackCredentials: relayContext?.credentials
                )
            }
            guard lifecycle == lifecycleGeneration else { return }

            if let existing = reusableActivity {
                activity = existing
                if let relayContext {
                    relayRegistration.observe(
                        activity: existing,
                        context: relayContext,
                        sessionID: sessionID
                    )
                }
                let latestState = currentState ?? state
                await existing.update(
                    ActivityContent(state: latestState, staleDate: staleDate(for: latestState))
                )
                lastSentUpdateAt = Date()
                return
            }

            let attributes = AgentRunActivityAttributes(
                sessionID: sessionID,
                sessionTitle: sessionTitle,
                streamID: streamID,
                startedAt: state.startedAt,
                relayPublisherID: relayContext?.publisherID
            )
            let requestedActivity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: staleDate(for: state)),
                pushType: relayContext == nil ? nil : .token
            )
            guard lifecycle == lifecycleGeneration else { return }
            activity = requestedActivity
            if let relayContext {
                relayRegistration.observe(
                    activity: requestedActivity,
                    context: relayContext,
                    sessionID: sessionID
                )
            }
            if let latestState = currentState, latestState != state {
                await requestedActivity.update(
                    ActivityContent(state: latestState, staleDate: staleDate(for: latestState))
                )
            }
            lastSentUpdateAt = Date()
        } catch {
            activity = nil
        }
    }

    private func updateCurrentState(
        immediate: Bool = true,
        _ transform: (AgentRunActivityAttributes.ContentState) -> AgentRunActivityAttributes.ContentState
    ) {
        guard let currentState else { return }

        let updatedState = transform(currentState)
        self.currentState = updatedState

        guard activity != nil else { return }
        scheduleUpdate(updatedState, immediate: immediate)
    }

    private func scheduleUpdate(
        _ state: AgentRunActivityAttributes.ContentState,
        immediate: Bool
    ) {
        let now = Date()
        if immediate || lastSentUpdateAt == nil || now.timeIntervalSince(lastSentUpdateAt!) >= minimumUpdateInterval {
            pendingUpdateTask?.cancel()
            pendingUpdateTask = nil
            let generation = nextUpdateGeneration()
            Task { [weak self, generation] in
                await self?.sendUpdate(state, staleDate: self?.staleDate(for: state), generation: generation)
            }
            return
        }

        guard pendingUpdateTask == nil else { return }

        let delay = max(0, minimumUpdateInterval - now.timeIntervalSince(lastSentUpdateAt!))
        pendingUpdateTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await MainActor.run {
                guard let self, !Task.isCancelled, let currentState = self.currentState else { return }
                self.pendingUpdateTask = nil
                let generation = self.nextUpdateGeneration()
                Task { [weak self, generation] in
                    await self?.sendUpdate(
                        currentState,
                        staleDate: self?.staleDate(for: currentState),
                        generation: generation
                    )
                }
            }
        }
    }

    private func sendUpdate(
        _ state: AgentRunActivityAttributes.ContentState,
        staleDate: Date?,
        generation: Int
    ) async {
        guard generation == updateGeneration else { return }
        guard let activity else { return }

        await activity.update(ActivityContent(state: state, staleDate: staleDate))
        lastSentUpdateAt = Date()
    }

    private func endActivity(
        _ endingActivity: Activity<AgentRunActivityAttributes>?,
        with finalState: AgentRunActivityAttributes.ContentState,
        status: AgentRunActivityStatus,
        endingSessionID: String?,
        lifecycle: Int
    ) async {
        guard let endingActivity else {
            resetIfStillCurrent(endingSessionID: endingSessionID, finalState: finalState)
            return
        }

        let policy = dismissalPolicy(for: status)
        let fallbackCredentials = TalariaRelayConfigurationStore.load()

        await endingActivity.update(ActivityContent(state: finalState, staleDate: nil))
        if AgentLiveActivityReusePolicy.preservesCompletedActivity(
            isFinal: finalState.isFinal, relayPublisherID: endingActivity.attributes.relayPublisherID
        ) {
            // A finished run remains addressable by the relay until acknowledgement.
            resetIfStillCurrent(endingSessionID: endingSessionID, finalState: finalState)
            return
        }
        if status == .complete {
            try? await Task.sleep(nanoseconds: 600_000_000)
        }

        if lifecycle != lifecycleGeneration {
            await endingActivity.end(nil, dismissalPolicy: .immediate)
        } else {
            await endingActivity.end(
                ActivityContent(state: finalState, staleDate: nil),
                dismissalPolicy: policy
            )
            resetIfStillCurrent(endingSessionID: endingSessionID, finalState: finalState)
        }
        unregisterRelayInBackground(
            activityID: endingActivity.id,
            fallbackCredentials: fallbackCredentials
        )
    }

    private func unregisterRelayInBackground(
        activityID: String,
        fallbackCredentials: TalariaRelayCredentials?
    ) {
        Task { [weak self, fallbackCredentials] in
            await self?.relayRegistration.unregister(
                activityID: activityID,
                fallbackCredentials: fallbackCredentials
            )
        }
    }

    private func dismissalPolicy(for status: AgentRunActivityStatus) -> ActivityUIDismissalPolicy {
        switch status {
        case .complete:
            .after(Date().addingTimeInterval(300))
        case .failed, .cancelled:
            .after(Date().addingTimeInterval(30))
        default:
            .default
        }
    }

    private func staleDate(for state: AgentRunActivityAttributes.ContentState) -> Date? {
        // #246: keep the widget looking current longer so a suspended run doesn't
        // get the dimmed "stale" treatment within seconds. The system-rendered
        // elapsed timer keeps ticking regardless of this window.
        state.isFinal ? nil : Date().addingTimeInterval(state.isStale ? 90 : 300)
    }

    private func reset() {
        activity = nil
        currentState = nil
        currentSessionID = nil
        currentStreamID = nil
        currentPublisherURL = nil
        activeConnectedStreamID = nil
        rawResponseText = ""
        lastSentUpdateAt = nil
        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
        relayRegistration.reset()
        _ = nextLifecycleGeneration()
        _ = nextUpdateGeneration()
    }

    private func nextUpdateGeneration() -> Int {
        updateGeneration += 1
        return updateGeneration
    }

    private func nextLifecycleGeneration() -> Int {
        lifecycleGeneration += 1
        return lifecycleGeneration
    }

    private func resetIfStillCurrent(
        endingSessionID: String?,
        finalState: AgentRunActivityAttributes.ContentState
    ) {
        guard currentSessionID == endingSessionID,
              currentState == finalState else {
            return
        }

        reset()
    }
}
