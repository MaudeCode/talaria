import ActivityKit
import Foundation
import TalariaKit

@MainActor
final class TalariaAggregateLiveActivityManager {
    static let shared = TalariaAggregateLiveActivityManager()
    private struct PendingSeed {
        let state: TalariaAggregateActivityAttributes.ContentState
        let expiresAt: Date
    }

    private static let seedLeaseInterval: TimeInterval = 30
    static let staleInterval: TimeInterval = 10 * 60
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var pushToStartTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    private var observedSessionToken: String?
    private var isRefreshing = false
    private var refreshRequested = false
    private var operationGeneration = 0
    private var activeDisconnectCount = 0
    private var pendingSeeds: [String: PendingSeed] = [:]
    private var aggregateUpdateTask: Task<Void, Never>?
    private var queuedAggregateState: TalariaAggregateActivityAttributes.ContentState?
    private var aggregateUpdateSequence = 0
    private var seedRegistrationTask: Task<Void, Never>?

    func armForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {
        guard TalariaLiveActivityMode.current == .allRunning,
              ActivityAuthorizationInfo().areActivitiesEnabled,
              let credentials = TalariaRelayConfigurationStore.operationalCredentials(for: publisherURL),
              let state = TalariaAggregateActivitySeed.make(
                  sessionID: sessionID,
                  sessionTitle: sessionTitle,
                  publisherURL: publisherURL
              ) else { return }

        let client = TalariaRelayClient(credentials: credentials)
        if observedSessionToken != credentials.sessionToken {
            stopObservers()
            observedSessionToken = credentials.sessionToken
        }
        prunePendingSeeds()
        guard let seedID = state.rows.first?.id else { return }
        pendingSeeds[seedID] = PendingSeed(
            state: state,
            expiresAt: Date().addingTimeInterval(Self.seedLeaseInterval)
        )

        let activities = Activity<TalariaAggregateActivityAttributes>.activities
        if let activity = activities.first {
            startObservers(client: client)
            scheduleSeedUpdate(for: activity, client: client, credentials: credentials)
            return
        }

        do {
            let activity = try Activity.request(
                attributes: TalariaAggregateActivityAttributes(),
                content: ActivityContent(
                    state: state,
                    staleDate: Date().addingTimeInterval(Self.staleInterval)
                ),
                pushType: .token
            )
            observePushToken(for: activity, client: client, seededLocally: true)
            startObservers(client: client)
        } catch {
            pendingSeeds.removeValue(forKey: seedID)
            return
        }
    }

    func refresh() async throws {
        guard activeDisconnectCount == 0 else { return }
        refreshRequested = true
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        var firstError: (any Error)?
        repeat {
            refreshRequested = false
            do {
                try await performRefresh()
            } catch {
                firstError = firstError ?? error
            }
        } while refreshRequested
        if let firstError { throw firstError }
    }

    private func performRefresh() async throws {
        let generation = operationGeneration
        let credentials = TalariaRelayConfigurationStore.load()
        guard TalariaLiveActivityMode.current == .allRunning, let credentials else {
            stopObservers()
            let client = credentials.map { TalariaRelayClient(credentials: $0) }
            if let client {
                let perSessionEnabled = TalariaLiveActivityMode.current == .perSession
                try? await client.configureDevice(
                    liveActivitiesEnabled: perSessionEnabled,
                    pushToStartEnabled: false
                )
            }
            await endAggregateActivities(client: client, preserveCompleted: credentials != nil)
            return
        }

        let client = TalariaRelayClient(credentials: credentials)
        if observedSessionToken != credentials.sessionToken {
            stopObservers()
            observedSessionToken = credentials.sessionToken
        }
        if let token = Activity<TalariaAggregateActivityAttributes>.pushToStartToken {
            UserDefaults.standard.set(
                token.map { String(format: "%02x", $0) }.joined(),
                forKey: TalariaRelayNotifications.pushToStartTokenKey
            )
        }
        startObservers(client: client)
        try await client.configureDevice()
        guard let aggregate = try await client.snapshot() else {
            guard generation == operationGeneration else { return }
            prunePendingSeeds()
            if !pendingSeeds.isEmpty,
               let activity = Activity<TalariaAggregateActivityAttributes>.activities.first {
                let state = stateByAddingPendingSeeds(to: activity.content.state)
                await enqueueUpdate(state, for: activity, generation: generation).value
                return
            }
            await endAggregateActivities(client: client)
            return
        }
        // A mode change or disconnect owns its cleanup; an older response must
        // not override that owner's completion-retention policy.
        guard operationIsCurrent(generation, credentials: credentials) else { return }

        for perSession in Activity<AgentRunActivityAttributes>.activities {
            if AgentLiveActivityReusePolicy.preservesCompletedActivity(
                isFinal: perSession.content.state.isFinal,
                relayPublisherID: perSession.attributes.relayPublisherID
            ) { continue }
            try? await client.unregister(activityID: perSession.id)
            await perSession.end(nil, dismissalPolicy: .immediate)
        }
        guard operationIsCurrent(generation, credentials: credentials) else { return }

        let reconciledAggregate = stateByReconcilingPendingSeeds(with: aggregate)
        let activities = Activity<TalariaAggregateActivityAttributes>.activities
        let activity: Activity<TalariaAggregateActivityAttributes>
        if let existing = activities.first {
            activity = existing
            await enqueueUpdate(reconciledAggregate, for: activity, generation: generation).value
            for duplicate in activities.dropFirst() {
                await duplicate.end(nil, dismissalPolicy: .immediate)
            }
        } else {
            // Expired or manually dismissed completion cards stay in the inbox.
            guard reconciledAggregate.activeCount > 0,
                  ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            activity = try Activity.request(
                attributes: TalariaAggregateActivityAttributes(),
                content: ActivityContent(
                    state: reconciledAggregate,
                    staleDate: Date().addingTimeInterval(Self.staleInterval)
                ),
                pushType: .token
            )
        }
        observePushToken(for: activity, client: client)
    }

    func reconcileAfterAcknowledgement(credentials: TalariaRelayCredentials) async throws {
        guard !Activity<TalariaAggregateActivityAttributes>.activities.isEmpty else { return }
        let generation = operationGeneration
        let client = TalariaRelayClient(credentials: credentials)
        let aggregate = try await client.snapshot()
        guard generation == operationGeneration, activeDisconnectCount == 0,
              TalariaRelayConfigurationStore.load() == credentials else { return }
        if TalariaLiveActivityMode.current == .perSession, aggregate?.hasTerminalRows != true {
            await endAggregateActivities(client: client)
            return
        }
        if let aggregate {
            let state = stateByReconcilingPendingSeeds(with: aggregate)
            for activity in Activity<TalariaAggregateActivityAttributes>.activities {
                await enqueueUpdate(state, for: activity, generation: generation).value
            }
        } else {
            prunePendingSeeds()
            guard pendingSeeds.isEmpty else { return }
            await endAggregateActivities(client: client)
        }
    }

    func disconnect(preserveCompleted: Bool = false) async throws {
        guard let credentials = TalariaRelayConfigurationStore.load() else { return }
        activeDisconnectCount += 1
        defer { activeDisconnectCount -= 1 }
        operationGeneration += 1
        refreshRequested = false
        await AgentLiveActivityManager.shared.disconnectRelayRegistration(preserveCompleted: preserveCompleted)
        let client = TalariaRelayClient(credentials: credentials)
        stopObservers()
        await endAggregateActivities(client: client, preserveCompleted: preserveCompleted)
        if !preserveCompleted { try await client.revokeDevice() }
    }

    private func startObservers(client: TalariaRelayClient) {
        for activity in Activity<TalariaAggregateActivityAttributes>.activities {
            observePushToken(for: activity, client: client)
        }
        if activityUpdatesTask == nil {
            activityUpdatesTask = Task { [weak self] in
                for await activity in Activity<TalariaAggregateActivityAttributes>.activityUpdates {
                    guard !Task.isCancelled else { return }
                    self?.observePushToken(for: activity, client: client)
                }
            }
        }
        if pushToStartTask == nil {
            pushToStartTask = Task {
                for await token in Activity<TalariaAggregateActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled else { return }
                    let tokenString = token.map { String(format: "%02x", $0) }.joined()
                    UserDefaults.standard.set(
                        tokenString,
                        forKey: TalariaRelayNotifications.pushToStartTokenKey
                    )
                    var retryDelay: Duration = .seconds(5)
                    while !Task.isCancelled, TalariaLiveActivityMode.current == .allRunning {
                        do {
                            try await client.configureDevice()
                            break
                        } catch {
                            if let error = error as? TalariaRelayClient.ClientError,
                               !error.isRetryable {
                                break
                            }
                            try? await Task.sleep(for: retryDelay)
                            retryDelay = min(retryDelay * 2, .seconds(300))
                        }
                    }
                }
            }
        }
    }

    private func observePushToken(
        for activity: Activity<TalariaAggregateActivityAttributes>,
        client: TalariaRelayClient,
        seededLocally: Bool = false
    ) {
        guard tokenTasks[activity.id] == nil else { return }
        tokenTasks[activity.id] = Task {
            var shouldSeedEmptyState = seededLocally
            for await token in activity.pushTokenUpdates {
                let tokenString = token.map { String(format: "%02x", $0) }.joined()
                var retryDelay: Duration = .seconds(5)
                while !Task.isCancelled {
                    do {
                        try await client.register(
                            activityID: activity.id,
                            pushToken: tokenString,
                            seededLocally: shouldSeedEmptyState
                        )
                        shouldSeedEmptyState = false
                        break
                    } catch {
                        if let error = error as? TalariaRelayClient.ClientError,
                           !error.isRetryable {
                            break
                        }
                        try? await Task.sleep(for: retryDelay)
                        retryDelay = min(retryDelay * 2, .seconds(300))
                    }
                }
            }
        }
    }

    private func endAggregateActivities(client: TalariaRelayClient? = nil, preserveCompleted: Bool = false) async {
        tokenTasks.values.forEach { $0.cancel() }
        tokenTasks.removeAll()
        for activity in Activity<TalariaAggregateActivityAttributes>.activities {
            // The shared card stays while any row still needs acknowledgement.
            if preserveCompleted && activity.content.state.hasTerminalRows { continue }
            if let client {
                try? await client.unregister(activityID: activity.id)
            }
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func stopObservers() {
        tokenTasks.values.forEach { $0.cancel() }
        tokenTasks.removeAll()
        pushToStartTask?.cancel()
        pushToStartTask = nil
        activityUpdatesTask?.cancel()
        activityUpdatesTask = nil
        aggregateUpdateTask?.cancel()
        aggregateUpdateTask = nil
        queuedAggregateState = nil
        aggregateUpdateSequence += 1
        seedRegistrationTask?.cancel()
        seedRegistrationTask = nil
        pendingSeeds.removeAll()
        observedSessionToken = nil
    }

    private func scheduleSeedUpdate(
        for activity: Activity<TalariaAggregateActivityAttributes>,
        client: TalariaRelayClient,
        credentials: TalariaRelayCredentials
    ) {
        let generation = operationGeneration
        let state = stateByAddingPendingSeeds(to: activity.content.state)
        let updateTask = enqueueUpdate(state, for: activity, generation: generation)
        seedRegistrationTask?.cancel()
        seedRegistrationTask = Task { [weak self] in
            await updateTask.value
            guard let self,
                  !Task.isCancelled,
                  self.operationIsCurrent(generation, credentials: credentials),
                  let token = activity.pushToken else { return }
            var retryDelay: Duration = .seconds(5)
            while !Task.isCancelled,
                  self.operationIsCurrent(generation, credentials: credentials) {
                do {
                    try await client.register(
                        activityID: activity.id,
                        pushToken: token.map { String(format: "%02x", $0) }.joined(),
                        seededLocally: true
                    )
                    return
                } catch {
                    if let error = error as? TalariaRelayClient.ClientError,
                       !error.isRetryable {
                        return
                    }
                    try? await Task.sleep(for: retryDelay)
                    retryDelay = min(retryDelay * 2, .seconds(300))
                }
            }
        }
    }

    private func enqueueUpdate(
        _ state: TalariaAggregateActivityAttributes.ContentState,
        for activity: Activity<TalariaAggregateActivityAttributes>,
        generation: Int
    ) -> Task<Void, Never> {
        let previous = aggregateUpdateTask
        aggregateUpdateSequence += 1
        let sequence = aggregateUpdateSequence
        queuedAggregateState = state
        let task = Task { [weak self] in
            guard let self else { return }
            await previous?.value
            defer {
                if sequence == self.aggregateUpdateSequence {
                    self.aggregateUpdateTask = nil
                    self.queuedAggregateState = nil
                }
            }
            guard !Task.isCancelled,
                  generation == self.operationGeneration,
                  sequence == self.aggregateUpdateSequence else { return }
            await activity.update(ActivityContent(
                state: state,
                staleDate: Date().addingTimeInterval(Self.staleInterval)
            ))
        }
        aggregateUpdateTask = task
        return task
    }

    private func stateByAddingPendingSeeds(
        to state: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        if let queuedAggregateState {
            prunePendingSeeds()
            return TalariaAggregateActivitySeed.merging(
                pendingSeeds.values.map(\.state),
                into: queuedAggregateState
            )
        }
        return stateByReconcilingPendingSeeds(with: state)
    }

    private func stateByReconcilingPendingSeeds(
        with aggregate: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        prunePendingSeeds()
        for row in aggregate.rows {
            guard let pending = pendingSeeds[row.id],
                  TalariaAggregateActivitySeed.authoritativeRowRetiresSeed(
                      row,
                      seed: pending.state
                  ) else { continue }
            pendingSeeds.removeValue(forKey: row.id)
        }
        return TalariaAggregateActivitySeed.merging(
            pendingSeeds.values.map(\.state),
            into: aggregate
        )
    }

    private func prunePendingSeeds(now: Date = Date()) {
        pendingSeeds = pendingSeeds.filter { $0.value.expiresAt > now }
    }

    private func operationIsCurrent(
        _ generation: Int,
        credentials: TalariaRelayCredentials
    ) -> Bool {
        generation == operationGeneration
            && activeDisconnectCount == 0
            && TalariaLiveActivityMode.current == .allRunning
            && TalariaRelayConfigurationStore.load()?.sessionToken == credentials.sessionToken
    }
}

enum TalariaAggregateActivitySeed {
    static func make(
        sessionID: String,
        sessionTitle: String,
        publisherURL: URL,
        now: Date = Date()
    ) -> TalariaAggregateActivityAttributes.ContentState? {
        let normalizedSessionID = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSessionID.isEmpty,
              let publisherID = TalariaRelayClient.originURL(publisherURL)?.absoluteString else {
            return nil
        }
        let timestamp = now.timeIntervalSince1970 * 1_000
        return TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 1,
            title: "Talaria",
            subtitle: String(localized: "1 active session"),
            updatedAt: timestamp,
            rows: [
                .init(
                    publisherId: publisherID,
                    publisherLabel: URL(string: publisherID)?.host() ?? "Hermes WebUI",
                    sessionId: normalizedSessionID,
                    title: AgentRunActivitySanitizer.sessionTitle(sessionTitle),
                    phase: "starting",
                    status: String(localized: "Connecting"),
                    updatedAt: timestamp,
                    deepLink: "/sessions/\(normalizedSessionID)"
                )
            ]
        )
    }

    static func merging(
        _ seed: TalariaAggregateActivityAttributes.ContentState,
        into existing: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        guard let seedRow = seed.rows.first else { return existing }
        let matchingRow = existing.rows.first { $0.id == seedRow.id }
        let wasActive = matchingRow.map { activePhases.contains($0.phase) } ?? false
        let visibleActiveCount = existing.rows.filter { activePhases.contains($0.phase) }.count
        let sessionMayBeHidden = matchingRow == nil
            && existing.activeCount > visibleActiveCount
            && existing.updatedAt >= seed.updatedAt
        let activeCount = max(1, existing.activeCount + (wasActive || sessionMayBeHidden ? 0 : 1))
        let rows = ([seedRow] + existing.rows.filter { $0.id != seedRow.id })
            .sorted {
                let lhsPriority = displayPriority($0.phase)
                let rhsPriority = displayPriority($1.phase)
                return lhsPriority == rhsPriority
                    ? $0.updatedAt > $1.updatedAt
                    : lhsPriority < rhsPriority
            }
            .prefix(TalariaAggregateLiveActivityPresentation.lockScreenRowLimit)

        var merged = existing
        merged.activeCount = activeCount
        if !rows.contains(where: {
            $0.phase == "waiting_for_approval" || $0.phase == "waiting_for_input"
        }) {
            merged.subtitle = activeCount == 1
                ? String(localized: "1 active session")
                : String.localizedStringWithFormat(
                    String(localized: "%lld active sessions"),
                    activeCount
                )
        }
        merged.updatedAt = max(existing.updatedAt, seed.updatedAt)
        merged.rows = Array(rows)
        return merged
    }

    static func merging(
        _ seeds: [TalariaAggregateActivityAttributes.ContentState],
        into existing: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        seeds.sorted { $0.updatedAt < $1.updatedAt }.reduce(existing) { state, seed in
            merging(seed, into: state)
        }
    }

    static func isActive(_ phase: String) -> Bool {
        activePhases.contains(phase)
    }

    static func authoritativeRowRetiresSeed(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row,
        seed: TalariaAggregateActivityAttributes.ContentState
    ) -> Bool {
        guard row.id == seed.rows.first?.id else { return false }
        if isActive(row.phase) {
            let isLocalPlaceholder = row.phase == "starting"
                && row.status == String(localized: "Connecting")
                && row.updatedAt == seed.updatedAt
            return !isLocalPlaceholder && row.updatedAt >= seed.updatedAt
        }
        return terminalPhases.contains(row.phase) && row.updatedAt >= seed.updatedAt
    }

    private static let activePhases: Set<String> = [
        "starting", "running", "waiting_for_approval", "waiting_for_input"
    ]
    private static let terminalPhases: Set<String> = ["completed", "failed", "cancelled"]

    private static func displayPriority(_ phase: String) -> Int {
        switch phase {
        case "waiting_for_approval", "waiting_for_input": 0
        case "failed": 1
        case "starting", "running": 2
        default: 3
        }
    }
}
