import ActivityKit
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
    private var tokenTask: Task<Void, Never>?
    private var client: TalariaRelayClient?
    private(set) var activityID: String?

    func observe(
        activity: Activity<AgentRunActivityAttributes>,
        context: PerSessionRelayContext,
        sessionID: String
    ) {
        tokenTask?.cancel()
        let client = TalariaRelayClient(credentials: context.credentials)
        self.client = client
        activityID = activity.id
        tokenTask = Task {
            var lastToken: String?

            func register(_ token: Data) async -> Bool {
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
                        return true
                    } catch {
                        if let error = error as? TalariaRelayClient.ClientError,
                           !error.isRetryable {
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
        }
        if let client {
            try? await client.unregister(activityID: activityID)
        }
    }

    func cancelObservation() {
        tokenTask?.cancel()
        tokenTask = nil
    }

    func reset() {
        tokenTask?.cancel()
        tokenTask = nil
        activityID = nil
        client = nil
    }
}
