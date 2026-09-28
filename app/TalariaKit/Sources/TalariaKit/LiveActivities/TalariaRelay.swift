public import AuthenticationServices
import CryptoKit
import Foundation

public struct TalariaRelayCredentials: Codable, Equatable {
    public var baseURL: URL
    public var deviceID: String
    var userID: String
    public var appleUserID: String
    public var sessionToken: String
    var expiresAt: Date?
    public var pendingRevocation: Bool?
    public var pairedPublisherIDs: [String]? = nil

    public var isExpired: Bool { expiresAt.map { $0 <= Date() } ?? true }
}

public enum TalariaRelayConnectionState: Equatable {
    case signedOut
    case expired
    case disconnectPending
    case unpaired
    case connected

    public var title: String {
        switch self {
        case .signedOut: String(localized: "Signed Out")
        case .expired: String(localized: "Sign In Required")
        case .disconnectPending: String(localized: "Disconnect Pending")
        case .unpaired: String(localized: "Not Connected")
        case .connected: String(localized: "Connected")
        }
    }
}

public enum TalariaRelayConfigurationStore {
    public static func load(keychain: any KeychainStoring = KeychainStore()) -> TalariaRelayCredentials? {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains(UITestFixtureLaunch.launchArgument) {
            return arguments.contains(UITestFixtureLaunch.relayConnectedArgument)
                ? UITestFixtureLaunch.relayCredentials
                : nil
        }
        #endif
        guard let encoded = try? keychain.load(.talariaRelay),
              let data = encoded.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(TalariaRelayCredentials.self, from: data)
    }

    public static func save(_ credentials: TalariaRelayCredentials, keychain: any KeychainStoring = KeychainStore()) throws {
        let data = try JSONEncoder().encode(credentials)
        guard let encoded = String(data: data, encoding: .utf8) else { return }
        try keychain.save(encoded, forKey: .talariaRelay)
    }

    public static func clear(keychain: any KeychainStoring = KeychainStore()) throws {
        try keychain.delete(.talariaRelay)
    }

    public static func recordPairedPublisher(
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

    public static func removePairedPublisher(
        _ publisherURL: URL,
        keychain: any KeychainStoring = KeychainStore()
    ) throws {
        guard var credentials = load(keychain: keychain),
              let publisherID = TalariaRelayClient.originURL(publisherURL)?.absoluteString else { return }
        credentials.pairedPublisherIDs = (credentials.pairedPublisherIDs ?? [])
            .filter { $0 != publisherID }
        try save(credentials, keychain: keychain)
    }

    public static func replacePairedPublishers(
        _ publisherIDs: [String],
        keychain: any KeychainStoring = KeychainStore()
    ) throws {
        guard var credentials = load(keychain: keychain) else { return }
        credentials.pairedPublisherIDs = Set(publisherIDs.compactMap(TalariaRelayClient.originIdentifier)).sorted()
        try save(credentials, keychain: keychain)
    }

    public static func connectionState(
        for server: URL,
        credentials: TalariaRelayCredentials?,
        now: Date = Date()
    ) -> TalariaRelayConnectionState {
        guard let credentials else { return .signedOut }
        if credentials.pendingRevocation == true { return .disconnectPending }
        guard credentials.expiresAt.map({ $0 > now }) == true else { return .expired }
        guard let publisherID = TalariaRelayClient.originURL(server)?.absoluteString,
              credentials.pairedPublisherIDs?.contains(publisherID) == true else { return .unpaired }
        return .connected
    }

    public static func operationalCredentials(
        for server: URL,
        keychain: any KeychainStoring = KeychainStore()
    ) -> TalariaRelayCredentials? {
        let credentials = load(keychain: keychain)
        guard connectionState(for: server, credentials: credentials) == .connected else { return nil }
        return credentials
    }

    public static func ownsCompletionAlerts(
        for server: URL,
        keychain: any KeychainStoring = KeychainStore(),
        defaults: UserDefaults = .standard
    ) -> Bool {
        operationalCredentials(for: server, keychain: keychain) != nil
            && defaults.string(forKey: TalariaRelayNotifications.pushTokenKey) != nil
    }
}

public final class TalariaRelayClient {
    struct AppleAuthResponse: Decodable {
        var userId: String
        var sessionToken: String
        var expiresAt: Double
    }

    struct PublisherInvitationResponse: Decodable {
        var invitation: String
    }

    public struct Completion: Codable, Identifiable, Equatable {
        public var id: String
        public var row: TalariaAggregateActivityAttributes.ContentState.Row
    }

    struct CompletionPage: Decodable {
        var completions: [Completion]
        var cursor: String?
    }

    struct SnapshotResponse: Decodable {
        var aggregate: TalariaAggregateActivityAttributes.ContentState?
    }

    public struct PublisherSubscription: Decodable, Equatable {
        public var publisherId: String
        public var label: String
        public var subscribed: Bool
    }

    private struct PublisherSubscriptionsResponse: Decodable {
        var publishers: [PublisherSubscription]
    }

    public enum ClientError: LocalizedError {
        case invalidURL
        case invalidResponse(Int, String?)

        public var isRetryable: Bool {
            guard case .invalidResponse(let status, _) = self else { return false }
            return status == 408 || status == 425 || status == 429 || status >= 500
        }

        public var errorDescription: String? {
            switch self {
            case .invalidURL: "Enter the HTTPS origin for the Talaria relay."
            case .invalidResponse(let status, let body): body ?? "Relay returned HTTP \(status)."
            }
        }
    }

    public let credentials: TalariaRelayCredentials
    let session: URLSession
    private let ownsSession: Bool

    public init(credentials: TalariaRelayCredentials, session: URLSession? = nil) {
        self.credentials = credentials
        ownsSession = session == nil
        self.session = session ?? Self.makeSession(baseURL: credentials.baseURL)
    }

    deinit {
        if ownsSession { session.finishTasksAndInvalidate() }
    }

    public static func makeAppleNonce() -> String {
        UUID().uuidString.lowercased()
    }

    public static func hashedAppleNonce(_ nonce: String) -> String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func signIn(
        identityToken: Data,
        nonce: String,
        appleUserID: String,
        deviceID: String? = nil,
        baseURL: URL = defaultBaseURL,
        session: URLSession? = nil
    ) async throws -> TalariaRelayCredentials {
        guard let identityToken = String(data: identityToken, encoding: .utf8) else {
            throw ClientError.invalidResponse(-1, "Apple did not return a valid identity token.")
        }
        let body = try JSONEncoder().encode(["identityToken": identityToken, "nonce": nonce])
        var request = URLRequest(url: endpoint(baseURL, "v1/auth/apple"))
        AppConfig.applyClientIdentity(to: &request)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let requestSession = session ?? makeSession(baseURL: baseURL)
        defer {
            if session == nil { requestSession.finishTasksAndInvalidate() }
        }
        let data = try await responseData(for: request, session: requestSession)
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

    public func createPublisherInvitation() async throws -> String {
        var request = authenticatedRequest(
            url: Self.endpoint(credentials.baseURL, "v1/pairings/publisher"),
            method: "POST"
        )
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data = try await Self.responseData(for: request, session: session)
        return try JSONDecoder().decode(PublisherInvitationResponse.self, from: data).invitation
    }

    public func publisherSubscriptions() async throws -> [PublisherSubscription] {
        let request = authenticatedRequest(
            url: Self.endpoint(
                credentials.baseURL,
                "v1/devices/\(credentials.deviceID)/publisher-subscriptions"
            ),
            method: "GET"
        )
        let data = try await Self.responseData(for: request, session: session)
        return try JSONDecoder().decode(PublisherSubscriptionsResponse.self, from: data).publishers
    }

    public func setPublisherSubscription(_ publisherID: URL, subscribed: Bool) async throws {
        guard let canonicalPublisherID = Self.originURL(publisherID)?.absoluteString else {
            throw ClientError.invalidURL
        }
        try await send(
            path: "v1/devices/\(credentials.deviceID)/publisher-subscriptions",
            method: "PUT",
            body: try JSONSerialization.data(withJSONObject: [
                "publisherId": canonicalPublisherID,
                "subscribed": subscribed
            ])
        )
    }

    public func revokePublisher(_ publisherID: URL) async throws {
        guard let canonicalPublisherID = Self.originURL(publisherID)?.absoluteString,
              var components = URLComponents(
                url: Self.endpoint(credentials.baseURL, "v1/publisher-enrollment"),
                resolvingAgainstBaseURL: false
              ) else { throw ClientError.invalidURL }
        components.queryItems = [URLQueryItem(name: "publisherId", value: canonicalPublisherID)]
        guard let url = components.url else { throw ClientError.invalidURL }
        let request = authenticatedRequest(url: url, method: "DELETE")
        _ = try await Self.responseData(for: request, session: session)
    }

    public func configureDevice(
        liveActivitiesEnabled: Bool = true,
        pushToStartEnabled: Bool = true
    ) async throws {
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
        if liveActivitiesEnabled, pushToStartEnabled, let pushToStartToken {
            body["pushToStartToken"] = pushToStartToken
        } else if !liveActivitiesEnabled || !pushToStartEnabled {
            body["pushToStartToken"] = NSNull()
        }
        try await send(
            path: "v1/devices/\(credentials.deviceID)",
            method: "PUT",
            body: try JSONSerialization.data(withJSONObject: body)
        )
    }

    public func snapshot() async throws -> TalariaAggregateActivityAttributes.ContentState? {
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

    func completions(cursor: String? = nil) async throws -> CompletionPage {
        var components = URLComponents(url: Self.endpoint(credentials.baseURL, "v1/activity-completions"), resolvingAgainstBaseURL: false)
        if let cursor { components?.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
        guard let url = components?.url else { throw ClientError.invalidURL }
        var request = authenticatedRequest(url: url, method: "GET")
        request.setValue(credentials.deviceID, forHTTPHeaderField: "X-Talaria-Device-Id")
        let data = try await Self.responseData(for: request, session: session)
        return try JSONDecoder().decode(CompletionPage.self, from: data)
    }

    func acknowledgeCompletions(ids: [String]) async throws {
        var request = authenticatedRequest(url: Self.endpoint(credentials.baseURL, "v1/activity-completions/acknowledge"), method: "POST")
        request.setValue(credentials.deviceID, forHTTPHeaderField: "X-Talaria-Device-Id")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["ids": ids])
        let data = try await Self.responseData(for: request, session: session)
        struct Response: Decodable { var ok: Bool }
        guard try JSONDecoder().decode(Response.self, from: data).ok else { throw ClientError.invalidResponse(409, nil) }
    }

    public func register(
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

    public func registerPerSession(
        activityID: String,
        pushToken: String,
        publisherID: String,
        sessionID: String,
        streamID: String? = nil
    ) async throws {
        var body: [String: Any] = [
            "mode": "per_session",
            "publisherId": publisherID,
            "sessionId": sessionID,
            "attributesType": "AgentRunActivityAttributes",
            "schemaVersion": 1,
            "activityPushToken": pushToken,
            "seededLocally": false
        ]
        if let streamID { body["streamId"] = streamID }
        try await send(
            path: "v1/devices/\(credentials.deviceID)/live-activities/\(activityID)",
            method: "PUT",
            body: try JSONSerialization.data(withJSONObject: body)
        )
    }

    public func unregister(activityID: String) async throws {
        try await send(path: "v1/devices/\(credentials.deviceID)/live-activities/\(activityID)", method: "DELETE")
    }

    public func revokeDevice() async throws {
        do {
            try await send(path: "v1/devices/\(credentials.deviceID)", method: "DELETE")
        } catch ClientError.invalidResponse(404, _) {
            return
        }
    }

    public func revokeSession() async throws {
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
        AppConfig.applyClientIdentity(to: &request)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(credentials.sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private static func endpoint(_ baseURL: URL, _ path: String) -> URL {
        path.split(separator: "/").reduce(baseURL) { $0.appendingPathComponent(String($1)) }
    }

    public static var defaultBaseURL: URL {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "TalariaRelayURL") as? String,
           let url = URL(string: configured) {
            return url
        }
        return URL(string: "https://relay.talaria.kil.dev")!
    }

    public static func originURL(_ url: URL) -> URL? {
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

    public static func originIdentifier(_ value: String) -> String? {
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

    private static func makeSession(baseURL: URL) -> URLSession {
        URLSession(
            configuration: .default,
            delegate: TalariaRelayRedirectGuard(baseURL: baseURL),
            delegateQueue: nil
        )
    }

    private static var apsEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}

final class TalariaRelayRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(
            request.url.map { APIClient.isSameOrigin($0, as: baseURL) } == true ? request : nil
        )
    }
}

public enum TalariaRelayAppleCredentialStatus: Equatable {
    case authorized
    case revoked
    case unknown
}

public enum TalariaRelayAppleCredentialState {
    public static func status(userID: String) async -> TalariaRelayAppleCredentialStatus {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(UITestFixtureLaunch.relayConnectedArgument) {
            return .authorized
        }
        #endif
        return await withCheckedContinuation { continuation in
            ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userID) { state, error in
                continuation.resume(returning: resolvedStatus(state: state, error: error))
            }
        }
    }

    static func resolvedStatus(
        state: ASAuthorizationAppleIDProvider.CredentialState,
        error: (any Error)?
    ) -> TalariaRelayAppleCredentialStatus {
        guard error == nil else { return .unknown }
        switch state {
        case .authorized: return .authorized
        case .revoked, .notFound: return .revoked
        case .transferred: return .unknown
        @unknown default: return .unknown
        }
    }
}

extension APIClient {
    public func pairTalariaRelay(invitation: String, relayURL: URL, publisherID: URL) async throws {
        let accepted = try await requestTalariaRelayPairing(invitation: invitation, relayURL: relayURL, publisherID: publisherID)
        guard accepted else { throw TalariaRelayClient.ClientError.invalidResponse(500, nil) }
    }
}
