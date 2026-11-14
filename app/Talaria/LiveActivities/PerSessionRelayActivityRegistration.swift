@preconcurrency import ActivityKit
import Foundation
import TalariaKit

struct PerSessionRelayContext {
    let credentials: TalariaRelayCredentials
    let publisherID: String

    static func make(for publisherURL: URL?) -> Self? {
        guard let publisherURL,
              let publisherID = TalariaRelayClient.originURL(publisherURL)?.absoluteString,
              let credentials = TalariaRelayConfigurationStore.operationalCredentials(for: publisherURL)
        else { return nil }
        return Self(credentials: credentials, publisherID: publisherID)
    }
}

@MainActor
final class PerSessionRelayActivityRegistration {
    enum Handoff: Equatable {
        case pending(activityID: String)
        case confirmed(activityID: String)
    }

    private var tokenTask: Task<Void, Never>?
    private var client: TalariaRelayClient?
    private(set) var activityID: String?
    /// Whether the relay has accepted the observed activity: `pending` until
    /// `registerPerSession` succeeds, nil once observation stops or fails.
    private(set) var handoff: Handoff?
    private var handoffWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

    func observe(
        activity: Activity<AgentRunActivityAttributes>,
        context: PerSessionRelayContext,
        sessionID: String
    ) {
        tokenTask?.cancel()
        let client = TalariaRelayClient(credentials: context.credentials)
        self.client = client
        activityID = activity.id
        beginHandoff(activityID: activity.id)
        tokenTask = Task { [weak self] in
            var lastToken: String?

            @MainActor func register(_ token: Data) async -> Bool {
                let tokenString = token.map { String(format: "%02x", $0) }.joined()
                guard tokenString != lastToken else { return true }
                var retryDelay: Duration = .seconds(5)
                while !Task.isCancelled {
                    do {
                        try await client.configureDevice(
                            liveActivitiesEnabled: true,
                            pushToStartEnabled: false
                        )
                        try await client.registerPerSession(
                            activityID: activity.id,
                            pushToken: tokenString,
                            publisherID: context.publisherID,
                            sessionID: sessionID,
                            streamID: activity.attributes.streamID
                        )
                        lastToken = tokenString
                        self?.settleHandoff(activityID: activity.id, confirmed: true)
                        return true
                    } catch {
                        if let error = error as? TalariaRelayClient.ClientError,
                           !error.isRetryable {
                            self?.settleHandoff(activityID: activity.id, confirmed: false)
                            return false
                        }
                        try? await Task.sleep(for: retryDelay)
                        retryDelay = min(retryDelay * 2, .seconds(300))
                    }
                }
                return false
            }

            if let token = activity.pushToken,
               !(await register(token)) {
                return
            }
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                if !(await register(token)) { return }
            }
        }
    }

    func unregister(
        activityID: String,
        fallbackCredentials: TalariaRelayCredentials? = nil
    ) async {
        let ownsActivity = self.activityID == activityID
        let fallbackClient = fallbackCredentials.map { TalariaRelayClient(credentials: $0) }
        let client = ownsActivity
            ? (self.client ?? fallbackClient)
            : fallbackClient
        if ownsActivity {
            tokenTask?.cancel()
            tokenTask = nil
            self.activityID = nil
            self.client = nil
            endHandoff()
        }
        if let client {
            try? await client.unregister(activityID: activityID)
        }
    }

    func cancelObservation() {
        tokenTask?.cancel()
        tokenTask = nil
        endHandoff()
    }

    func reset() {
        tokenTask?.cancel()
        tokenTask = nil
        activityID = nil
        client = nil
        endHandoff()
    }

    /// True once the relay confirms `activityID`; false when its registration
    /// fails, observation stops, or nothing settles within `limit`.
    func awaitRegistration(activityID: String, limit: Duration) async -> Bool {
        switch handoff {
        case .confirmed(activityID): return true
        case .pending(activityID): break
        default: return false
        }
        let waiterID = UUID()
        let timeout = Task { [weak self] in
            try? await Task.sleep(for: limit)
            self?.resumeWaiter(waiterID, with: false)
        }
        defer { timeout.cancel() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled {
                    continuation.resume(returning: false)
                } else {
                    handoffWaiters[waiterID] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resumeWaiter(waiterID, with: false) }
        }
    }

    func beginHandoff(activityID: String) {
        // Re-observing the same activity keeps its confirmation and waiters.
        guard handoffActivityID != activityID else { return }
        endHandoff()
        handoff = .pending(activityID: activityID)
    }

    func settleHandoff(activityID: String, confirmed: Bool) {
        guard handoffActivityID == activityID else { return }
        handoff = confirmed ? .confirmed(activityID: activityID) : nil
        resumeWaiters(with: confirmed)
    }

    private var handoffActivityID: String? {
        switch handoff {
        case .pending(let activityID), .confirmed(let activityID): activityID
        case nil: nil
        }
    }

    private func endHandoff() {
        handoff = nil
        resumeWaiters(with: false)
    }

    private func resumeWaiters(with result: Bool) {
        let waiters = handoffWaiters.values
        handoffWaiters.removeAll()
        for waiter in waiters { waiter.resume(returning: result) }
    }

    private func resumeWaiter(_ waiterID: UUID, with result: Bool) {
        handoffWaiters.removeValue(forKey: waiterID)?.resume(returning: result)
    }
}
