import ActivityKit
import AuthenticationServices
import CryptoKit
import Foundation
import OSLog

private let liveActivityReconcilerLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
    category: "LiveActivityReconciler"
)

enum AgentLiveActivityEvent: Equatable {
    case sessionTitle(String)
    case token(String)
    case interimAssistant(String)
    case clearResponseExcerpt
    case reasoning(String)
    case toolStarted(name: String?)
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
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String)
    func start(sessionID: String, sessionTitle: String, streamID: String?)
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
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String) {}
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
    private var currentState: AgentRunActivityAttributes.ContentState?
    private var currentSessionID: String?
    private var currentStreamID: String?
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

    init(minimumUpdateInterval: TimeInterval = 1.5) {
        self.minimumUpdateInterval = minimumUpdateInterval
    }

    func armAggregateForLocalWork(sessionID: String, sessionTitle: String) {
        TalariaAggregateLiveActivityManager.shared.armForLocalWork(
            sessionID: sessionID,
            sessionTitle: sessionTitle
        )
    }

    func start(sessionID: String, sessionTitle: String, streamID: String?) {
        let normalizedSessionID = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSessionID.isEmpty else { return }
        let normalizedStreamID = AgentLiveActivityReusePolicy.normalizedStreamID(streamID)
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
                    startedAt: state.startedAt,
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
        rawResponseText = ""
        currentSessionID = normalizedSessionID
        currentStreamID = normalizedStreamID
        let startedAt = Date()
        let state = AgentRunActivityStateReducer.initialState(
            sessionID: normalizedSessionID,
            sessionTitle: sessionTitle,
            startedAt: startedAt
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

        Task { [weak self, lifecycle] in
            await self?.requestOrUpdateActivity(
                sessionID: normalizedSessionID,
                streamID: normalizedStreamID,
                sessionTitle: state.sessionTitle,
                state: state,
                lifecycle: lifecycle
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
            if let endingActivity {
                await endingActivity.end(nil, dismissalPolicy: .immediate)
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
                lifecycle: lifecycle
            )
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
        case .toolStarted(let name):
            updateCurrentState { state in
                AgentRunActivityStateReducer.toolStarted(name: name, state: state)
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
            // `end(content:)` sets the final content directly and there is no
            // intervening render delay here, so a preceding `update` is redundant
            // (PR #266 review).
            await persisted.end(
                ActivityContent(state: finalState, staleDate: nil),
                dismissalPolicy: dismissalPolicy(for: status)
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

    private func requestOrUpdateActivity(
        sessionID: String,
        streamID: String?,
        sessionTitle: String,
        state: AgentRunActivityAttributes.ContentState,
        lifecycle: Int
    ) async {
        guard lifecycle == lifecycleGeneration else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            return
        }

        do {
            let existingActivities = Activity<AgentRunActivityAttributes>.activities
            let reusableActivity = existingActivities.first { existing in
                AgentLiveActivityReusePolicy.canReuseActivity(
                    existingSessionID: existing.attributes.sessionID,
                    existingStreamID: existing.attributes.streamID,
                    requestedSessionID: sessionID,
                    requestedStreamID: streamID
                )
            }

            for staleActivity in existingActivities {
                if let reusableActivity, staleActivity.id == reusableActivity.id {
                    continue
                }

                await staleActivity.end(nil, dismissalPolicy: .immediate)
            }
            guard lifecycle == lifecycleGeneration else { return }

            if let existing = reusableActivity {
                activity = existing
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
                startedAt: state.startedAt
            )
            let requestedActivity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: staleDate(for: state)),
                pushType: nil
            )
            guard lifecycle == lifecycleGeneration else { return }
            activity = requestedActivity
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

        await endingActivity.update(ActivityContent(state: finalState, staleDate: nil))
        if status == .complete {
            try? await Task.sleep(nanoseconds: 600_000_000)
        }

        guard lifecycle == lifecycleGeneration else {
            await endingActivity.end(nil, dismissalPolicy: .immediate)
            return
        }

        await endingActivity.end(
            ActivityContent(state: finalState, staleDate: nil),
            dismissalPolicy: policy
        )
        resetIfStillCurrent(endingSessionID: endingSessionID, finalState: finalState)
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
        activeConnectedStreamID = nil
        rawResponseText = ""
        lastSentUpdateAt = nil
        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
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

struct TalariaRelayCredentials: Codable, Equatable {
    var baseURL: URL
    var deviceID: String
    var userID: String
    var appleUserID: String
    var sessionToken: String
    var expiresAt: Date?
    var pendingRevocation: Bool?
    var pairedPublisherIDs: [String]? = nil

    var isExpired: Bool { expiresAt.map { $0 <= Date() } ?? true }
}

enum TalariaRelayConfigurationStore {
    static func load(keychain: any KeychainStoring = KeychainStore()) -> TalariaRelayCredentials? {
        guard let encoded = try? keychain.load(.talariaRelay),
              let data = encoded.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(TalariaRelayCredentials.self, from: data)
    }

    static func save(_ credentials: TalariaRelayCredentials, keychain: any KeychainStoring = KeychainStore()) throws {
        let data = try JSONEncoder().encode(credentials)
        guard let encoded = String(data: data, encoding: .utf8) else { return }
        try keychain.save(encoded, forKey: .talariaRelay)
    }

    static func clear(keychain: any KeychainStoring = KeychainStore()) throws {
        try keychain.delete(.talariaRelay)
    }

    static func recordPairedPublisher(
        _ publisherURL: URL,
        keychain: any KeychainStoring = KeychainStore()
    ) throws {
        guard var credentials = load(keychain: keychain),
              let publisherID = TalariaRelayClient.originURL(publisherURL)?.absoluteString else { return }
        var publisherIDs = Set(credentials.pairedPublisherIDs ?? [])
        publisherIDs.insert(publisherID)
        credentials.pairedPublisherIDs = publisherIDs.sorted()
        try save(credentials, keychain: keychain)
    }

    static func ownsCompletionAlerts(
        for server: URL,
        keychain: any KeychainStoring = KeychainStore()
    ) -> Bool {
        guard TalariaLiveActivityMode.current == .allRunning,
              let credentials = load(keychain: keychain),
              !credentials.isExpired,
              credentials.pendingRevocation != true,
              let publisherID = TalariaRelayClient.originURL(server)?.absoluteString else { return false }
        return credentials.pairedPublisherIDs?.contains(publisherID) == true
    }
}

struct TalariaRelayClient {
    struct AppleAuthResponse: Decodable {
        var userId: String
        var sessionToken: String
        var expiresAt: Double
    }

    struct PublisherInvitationResponse: Decodable {
        var invitation: String
    }

    struct SnapshotResponse: Decodable {
        var aggregate: TalariaAggregateActivityAttributes.ContentState?
    }

    enum ClientError: LocalizedError {
        case invalidURL
        case invalidResponse(Int, String?)

        var isRetryable: Bool {
            guard case .invalidResponse(let status, _) = self else { return false }
            return status == 408 || status == 425 || status == 429 || status >= 500
        }

        var errorDescription: String? {
            switch self {
            case .invalidURL: "Enter the HTTPS origin for the Talaria relay."
            case .invalidResponse(let status, let body): body ?? "Relay returned HTTP \(status)."
            }
        }
    }

    let credentials: TalariaRelayCredentials
    var session: URLSession = .shared

    static func makeAppleNonce() -> String {
        UUID().uuidString.lowercased()
    }

    static func hashedAppleNonce(_ nonce: String) -> String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func signIn(
        identityToken: Data,
        nonce: String,
        appleUserID: String,
        deviceID: String? = nil,
        baseURL: URL = defaultBaseURL,
        session: URLSession = .shared
    ) async throws -> TalariaRelayCredentials {
        guard let identityToken = String(data: identityToken, encoding: .utf8) else {
            throw ClientError.invalidResponse(-1, "Apple did not return a valid identity token.")
        }
        let body = try JSONEncoder().encode(["identityToken": identityToken, "nonce": nonce])
        var request = URLRequest(url: endpoint(baseURL, "v1/auth/apple"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data = try await responseData(for: request, session: session)
        let response = try JSONDecoder().decode(AppleAuthResponse.self, from: data)
        return TalariaRelayCredentials(
            baseURL: baseURL,
            deviceID: deviceID ?? "dev_\(UUID().uuidString.lowercased())",
            userID: response.userId,
            appleUserID: appleUserID,
            sessionToken: response.sessionToken,
            expiresAt: Date(timeIntervalSince1970: response.expiresAt / 1_000)
        )
    }

    func createPublisherInvitation() async throws -> String {
        var request = authenticatedRequest(
            url: Self.endpoint(credentials.baseURL, "v1/pairings/publisher"),
            method: "POST"
        )
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data = try await Self.responseData(for: request, session: session)
        return try JSONDecoder().decode(PublisherInvitationResponse.self, from: data).invitation
    }

    func configureDevice(liveActivitiesEnabled: Bool = true) async throws {
        let pushToken = UserDefaults.standard.string(forKey: TalariaRelayNotifications.pushTokenKey)
        let pushToStartToken = UserDefaults.standard.string(
            forKey: TalariaRelayNotifications.pushToStartTokenKey
        )
        let approvalInputAlertsEnabled = UserDefaults.standard.bool(
            forKey: TalariaRelayNotifications.isEnabledKey
        )
        let completionAlertsEnabled = UserDefaults.standard.bool(
            forKey: ResponseCompletionNotifications.isEnabledKey
        )
        let notificationsEnabled = liveActivitiesEnabled
            && (approvalInputAlertsEnabled || completionAlertsEnabled)
            && pushToken != nil
        let preferences: [String: Bool] = [
            "liveActivitiesEnabled": liveActivitiesEnabled,
            "notificationsEnabled": notificationsEnabled,
            "notifyOnApproval": approvalInputAlertsEnabled,
            "notifyOnInput": approvalInputAlertsEnabled,
            "notifyOnCompletion": completionAlertsEnabled,
            "notifyOnFailure": completionAlertsEnabled
        ]
        var body: [String: Any] = [
            "label": "Talaria iPhone",
            "bundleId": Bundle.main.bundleIdentifier ?? "dev.kil.talaria",
            "apsEnvironment": Self.apsEnvironment,
            "preferences": preferences
        ]
        if let pushToken {
            body["pushToken"] = pushToken
        }
        if liveActivitiesEnabled, let pushToStartToken {
            body["pushToStartToken"] = pushToStartToken
        } else if !liveActivitiesEnabled {
            body["pushToStartToken"] = NSNull()
        }
        try await send(
            path: "v1/devices/\(credentials.deviceID)",
            method: "PUT",
            body: try JSONSerialization.data(withJSONObject: body)
        )
    }

    func snapshot() async throws -> TalariaAggregateActivityAttributes.ContentState? {
        var components = URLComponents(
            url: Self.endpoint(credentials.baseURL, "v1/activity-snapshot"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "mode", value: "all_running")]
        guard let url = components?.url else { throw ClientError.invalidURL }
        var request = authenticatedRequest(url: url, method: "GET")
        request.setValue(credentials.deviceID, forHTTPHeaderField: "X-Talaria-Device-Id")
        let data = try await Self.responseData(for: request, session: session)
        return try JSONDecoder().decode(SnapshotResponse.self, from: data).aggregate
    }

    func register(
        activityID: String,
        pushToken: String,
        seededLocally: Bool = false
    ) async throws {
        let body: [String: Any] = [
            "mode": "all_running",
            "attributesType": "TalariaAggregateActivityAttributes",
            "schemaVersion": 1,
            "activityPushToken": pushToken,
            "seededLocally": seededLocally
        ]
        try await send(
            path: "v1/devices/\(credentials.deviceID)/live-activities/\(activityID)",
            method: "PUT",
            body: try JSONSerialization.data(withJSONObject: body)
        )
    }

    func unregister(activityID: String) async throws {
        try await send(path: "v1/devices/\(credentials.deviceID)/live-activities/\(activityID)", method: "DELETE")
    }

    func revokeDevice() async throws {
        do {
            try await send(path: "v1/devices/\(credentials.deviceID)", method: "DELETE")
        } catch ClientError.invalidResponse(404, _) {
            return
        }
    }

    func revokeSession() async throws {
        do {
            try await send(path: "v1/auth/session", method: "DELETE")
        } catch ClientError.invalidResponse(404, _) {
            return
        }
    }

    private func send(path: String, method: String, body: Data) async throws {
        var request = authenticatedRequest(url: Self.endpoint(credentials.baseURL, path), method: method)
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await Self.responseData(for: request, session: session)
    }

    private func send(path: String, method: String) async throws {
        let request = authenticatedRequest(url: Self.endpoint(credentials.baseURL, path), method: method)
        _ = try await Self.responseData(for: request, session: session)
    }

    private func authenticatedRequest(url: URL, method: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(credentials.sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private static func endpoint(_ baseURL: URL, _ path: String) -> URL {
        path.split(separator: "/").reduce(baseURL) { $0.appendingPathComponent(String($1)) }
    }

    static var defaultBaseURL: URL {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "TalariaRelayURL") as? String,
           let url = URL(string: configured) {
            return url
        }
        return URL(string: "https://relay.talaria.kil.dev")!
    }

    static func originURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.host != nil,
              components.user == nil,
              components.password == nil else { return nil }
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.host = components.host?.lowercased()
        if (components.scheme?.lowercased() == "https" && components.port == 443)
            || (components.scheme?.lowercased() == "http" && components.port == 80) {
            components.port = nil
        }
        return components.url
    }

    static func originIdentifier(_ value: String) -> String? {
        URL(string: value).flatMap(originURL)?.absoluteString
    }

    private static func responseData(for request: URLRequest, session: URLSession) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse(-1, nil)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw ClientError.invalidResponse(response.statusCode, String(data: data, encoding: .utf8))
        }
        return data
    }

    private static var apsEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}

enum TalariaRelayAppleCredentialState {
    static func isAuthorized(userID: String) async -> Bool {
        await withCheckedContinuation { continuation in
            ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userID) { state, error in
                continuation.resume(returning: error != nil || state == .authorized)
            }
        }
    }
}

private struct TalariaRelayPairRequest: Encodable {
    var relayURL: String
    var publisherID: String
    var publisherInvitation: String
    var label: String
}

private struct TalariaRelayPairResponse: Decodable {
    var ok: Bool
}

extension APIClient {
    func pairTalariaRelay(invitation: String, relayURL: URL, publisherID: URL) async throws {
        let response: TalariaRelayPairResponse = try await send(
            endpoint: .talariaRelayPair,
            method: "POST",
            body: TalariaRelayPairRequest(
                relayURL: relayURL.absoluteString,
                publisherID: publisherID.absoluteString,
                publisherInvitation: invitation,
                label: publisherID.host() ?? "Hermes WebUI"
            )
        )
        guard response.ok else { throw TalariaRelayClient.ClientError.invalidResponse(500, nil) }
    }
}

@MainActor
final class TalariaAggregateLiveActivityManager {
    static let shared = TalariaAggregateLiveActivityManager()
    private struct PendingSeed {
        let state: TalariaAggregateActivityAttributes.ContentState
        let expiresAt: Date
    }

    private static let seedLeaseInterval: TimeInterval = 30
    private static let staleInterval: TimeInterval = 150
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
    private var seedRegistrationTask: Task<Void, Never>?

    func armForLocalWork(sessionID: String, sessionTitle: String) {
        guard TalariaLiveActivityMode.current == .allRunning,
              ActivityAuthorizationInfo().areActivitiesEnabled,
              let account = ServerRegistry.shared.activeServer,
              let server = URL(string: account.urlString),
              TalariaRelayConfigurationStore.ownsCompletionAlerts(for: server),
              let credentials = TalariaRelayConfigurationStore.load(),
              let state = TalariaAggregateActivitySeed.make(
                  sessionID: sessionID,
                  sessionTitle: sessionTitle,
                  publisherURL: server
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
                try? await client.configureDevice(liveActivitiesEnabled: false)
            }
            await endAggregateActivities(client: client)
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
        guard operationIsCurrent(generation, credentials: credentials) else {
            await endAggregateActivities(client: client)
            return
        }

        for perSession in Activity<AgentRunActivityAttributes>.activities {
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
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
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

    func disconnect() async throws {
        guard let credentials = TalariaRelayConfigurationStore.load() else { return }
        activeDisconnectCount += 1
        defer { activeDisconnectCount -= 1 }
        operationGeneration += 1
        refreshRequested = false
        let client = TalariaRelayClient(credentials: credentials)
        stopObservers()
        await endAggregateActivities(client: client)
        try await client.revokeDevice()
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

    private func endAggregateActivities(client: TalariaRelayClient? = nil) async {
        tokenTasks.values.forEach { $0.cancel() }
        tokenTasks.removeAll()
        for activity in Activity<TalariaAggregateActivityAttributes>.activities {
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
        let task = Task {
            await previous?.value
            guard !Task.isCancelled, generation == operationGeneration else { return }
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
        prunePendingSeeds()
        return TalariaAggregateActivitySeed.merging(
            pendingSeeds.values.map(\.state),
            into: state
        )
    }

    private func stateByReconcilingPendingSeeds(
        with aggregate: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        prunePendingSeeds()
        for row in aggregate.rows where TalariaAggregateActivitySeed.isActive(row.phase) {
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
        let activeCount = max(1, existing.activeCount + (wasActive ? 0 : 1))
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

    private static let activePhases: Set<String> = [
        "starting", "running", "waiting_for_approval", "waiting_for_input"
    ]

    private static func displayPriority(_ phase: String) -> Int {
        switch phase {
        case "waiting_for_approval", "waiting_for_input": 0
        case "failed": 1
        case "starting", "running": 2
        default: 3
        }
    }
}

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
