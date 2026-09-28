import Foundation
import os

public actor APIClient {
    private static let reauthenticationServers = OSAllocatedUnfairLock(initialState: [UUID: URL]())

    public nonisolated static func setReauthenticationRequired(_ server: URL?, owner: UUID) {
        reauthenticationServers.withLock { $0[owner] = server }
    }

    func requireMutationAuthorization() throws {
        guard !Self.reauthenticationServers.withLock({ $0.values.contains(baseURL) }) else {
            throw APIError.unauthorized
        }
    }

    let baseURL: URL
    let session: URLSession
    let publicMediaSession: URLSession
    /// The redirect guard wired into both default sessions. Strips the user's
    /// custom headers when the server redirects a same-origin request to a
    /// cross-origin host (#277). `nonisolated` so tests can drive the exact
    /// delegate the client installs; it is immutable and `Sendable`.
    nonisolated let redirectHeaderStripper: CrossOriginHeaderStripper
    /// Sessions this client created (vs. ones a caller injected). A `URLSession`
    /// built with a delegate keeps a strong reference to it and to itself until
    /// invalidated, so we tear these down in `deinit` to avoid leaking them — many
    /// `APIClient`s are created ad hoc and discarded (#277).
    private let ownedSessions: [URLSession]
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let cookieStorage: HTTPCookieStorage?
    let persistCookies: @Sendable () throws -> Void
    /// Forgets which OIDC-bound profile owns this server's local cache and
    /// drafts after a successful in-app profile switch. Switching is only
    /// possible for an unbound session, whose cache may then hold state of a
    /// profile that another identity is bound to, so the next native OIDC
    /// sign-in on this server must purge regardless of which profile it maps
    /// to (TAL-131). Defaults follow `persistCookies`: the Keychain marker in
    /// production, a no-op for injected sessions.
    let forgetProfileOwner: @Sendable () throws -> Void
    /// Read when building each request so live edits apply without rebuilding the
    /// client. Defaults to the process-wide store; tests inject a fixed list (#255).
    /// Internal, not private, because the upload and transcribe extensions build
    /// their multipart requests by hand and need the same header injection (#61).
    let customHeaderProvider: @Sendable () -> [CustomHeader]

    public init(
        baseURL: URL,
        session: URLSession? = nil,
        publicMediaSession: URLSession? = nil,
        cookieStorage: HTTPCookieStorage? = nil,
        cookiePersistence: (@Sendable () throws -> Void)? = nil,
        forgetProfileOwner: (@Sendable () throws -> Void)? = nil,
        customHeaderProvider: @escaping @Sendable () -> [CustomHeader] = { CustomHeaderStore.shared.snapshot() }
    ) {
        self.baseURL = baseURL
        self.customHeaderProvider = customHeaderProvider

        // One redirect guard shared by both sessions (same origin + same header
        // provider). Wired into the default sessions so a server-issued
        // same-origin → cross-origin redirect can't forward the user's custom
        // headers off-origin (#277).
        let redirectHeaderStripper = CrossOriginHeaderStripper(
            baseURL: baseURL,
            customHeaderProvider: customHeaderProvider
        )
        self.redirectHeaderStripper = redirectHeaderStripper

        let resolvedCookieStorage = cookieStorage
            ?? session?.configuration.httpCookieStorage
            ?? ServerCookieStore.shared.storage(for: baseURL)
        let resolvedSession = session ?? Self.makeDefaultSession(
            delegate: redirectHeaderStripper,
            cookieStorage: resolvedCookieStorage
        )
        let resolvedPublicMediaSession = publicMediaSession
            ?? Self.makeDefaultPublicMediaSession(delegate: redirectHeaderStripper)
        self.session = resolvedSession
        self.publicMediaSession = resolvedPublicMediaSession
        self.cookieStorage = resolvedCookieStorage
        if let cookiePersistence {
            persistCookies = cookiePersistence
        } else if session == nil, cookieStorage == nil {
            persistCookies = { try ServerCookieStore.shared.persist(for: baseURL) }
        } else {
            persistCookies = {}
        }
        if let forgetProfileOwner {
            self.forgetProfileOwner = forgetProfileOwner
        } else if session == nil, cookieStorage == nil {
            self.forgetProfileOwner = {
                try KeychainStore().delete(.authenticatedProfile, scope: baseURL.absoluteString)
            }
        } else {
            self.forgetProfileOwner = {}
        }
        // Only the sessions we created carry our delegate and must be invalidated;
        // an injected session is the caller's to manage.
        var ownedSessions: [URLSession] = []
        if session == nil { ownedSessions.append(resolvedSession) }
        if publicMediaSession == nil { ownedSessions.append(resolvedPublicMediaSession) }
        self.ownedSessions = ownedSessions

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder

        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        self.encoder = encoder
    }

    deinit {
        // Break the session ↔ delegate retain so the sessions we created don't
        // outlive this client (#277). `finishTasksAndInvalidate` lets any in-flight
        // request finish first; by deinit there should be none, since an in-flight
        // actor call keeps `self` alive.
        for session in ownedSessions {
            session.finishTasksAndInvalidate()
        }
    }

    public func health() async throws -> HealthResponse {
        try await send(endpoint: .health, method: "GET")
    }

    public func authStatus() async throws -> AuthStatusResponse {
        try await send(endpoint: .authStatus, method: "GET")
    }

    public func login(password: String) async throws -> LoginResponse {
        try await send(
            endpoint: .login,
            method: "POST",
            body: LoginRequest(password: password)
        )
    }

    public func logout() async throws -> LoginResponse {
        try await send(endpoint: .logout, method: "POST", body: EmptyBody())
    }

    public func beginNativeOIDC(
        callbackURL: URL,
        state: String,
        codeChallenge: String
    ) async throws -> NativeOIDCStartResponse {
        try await send(
            endpoint: .nativeOIDCStart,
            method: "POST",
            body: NativeOIDCStartRequest(
                callbackUrl: callbackURL.absoluteString,
                state: state,
                codeChallenge: codeChallenge,
                codeChallengeMethod: "S256"
            )
        )
    }

    public func exchangeNativeOIDC(
        flowID: String,
        code: String,
        state: String,
        codeVerifier: String
    ) async throws -> LoginResponse {
        let body = NativeOIDCExchangeRequest(
            flowId: flowID,
            code: code,
            state: state,
            codeVerifier: codeVerifier
        )
        let (data, response) = try await sendDataReturningResponse(
            endpoint: .nativeOIDCExchange,
            method: "POST",
            encodedBody: encoder.encode(body)
        )
        let headerFields = response.allHeaderFields.reduce(into: [String: String]()) {
            $0[String(describing: $1.key)] = String(describing: $1.value)
        }
        guard let responseURL = response.url, let cookieStorage else {
            throw APIError.unauthorized
        }
        let responseCookies = HTTPCookie.cookies(
            withResponseHeaderFields: headerFields,
            for: responseURL
        )
        let requiresSecureCookie = responseURL.scheme?.lowercased() == "https"
        let secureSessionCookies = responseCookies.filter {
            $0.isHTTPOnly && (!requiresSecureCookie || $0.isSecure)
        }
        guard !secureSessionCookies.isEmpty else {
            responseCookies.forEach(cookieStorage.deleteCookie)
            throw APIError.unauthorized
        }
        responseCookies.forEach(cookieStorage.setCookie)
        let authStatusURL = Endpoint.authStatus.url(relativeTo: baseURL)
        let applicable = cookieStorage.cookies(for: authStatusURL) ?? []
        guard secureSessionCookies.contains(where: { candidate in
            applicable.contains(where: {
                $0.name == candidate.name
                    && $0.domain == candidate.domain
                    && $0.path == candidate.path
                    && $0.value == candidate.value
            })
        }) else {
            responseCookies.forEach(cookieStorage.deleteCookie)
            throw APIError.unauthorized
        }
        return try decode(LoginResponse.self, from: data)
    }

    public func cancelNativeOIDC(flowID: String, state: String) async throws -> LoginResponse {
        try await send(
            endpoint: .nativeOIDCCancel,
            method: "POST",
            body: NativeOIDCCancelRequest(flowId: flowID, state: state)
        )
    }

    func send<Response: Decodable>(
        endpoint: Endpoint,
        method: String
    ) async throws -> Response {
        let data = try await sendData(endpoint: endpoint, method: method, encodedBody: nil)
        return try decode(Response.self, from: data)
    }

    func send<Response: Decodable, Body: Encodable>(
        endpoint: Endpoint,
        method: String,
        body: Body?,
        timeout: TimeInterval? = nil
    ) async throws -> Response {
        let encodedBody = try body.map { try encoder.encode($0) }
        let data = try await sendData(endpoint: endpoint, method: method, encodedBody: encodedBody, timeout: timeout)
        return try decode(Response.self, from: data)
    }

    func decode<Response: Decodable>(_ type: Response.Type, from data: Data) throws -> Response {
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(underlying: error)
        }
    }

    func sendData(
        endpoint: Endpoint,
        method: String
    ) async throws -> Data {
        try await sendData(endpoint: endpoint, method: method, encodedBody: nil)
    }

    func sendData<Body: Encodable>(
        endpoint: Endpoint,
        method: String,
        body: Body?
    ) async throws -> Data {
        let encodedBody = try body.map { try encoder.encode($0) }
        return try await sendData(endpoint: endpoint, method: method, encodedBody: encodedBody)
    }

    func sendData(
        endpoint: Endpoint,
        method: String,
        encodedBody: Data?,
        timeout: TimeInterval? = nil
    ) async throws -> Data {
        try await sendDataReturningResponse(
            endpoint: endpoint,
            method: method,
            encodedBody: encodedBody,
            timeout: timeout
        ).0
    }

    /// Same request/error contract as `sendData`, but also returns the
    /// `HTTPURLResponse` so callers can read response headers (e.g. the
    /// `Content-Disposition` filename on `GET /api/session/export`).
    ///
    /// `accept` overrides the default `application/json` Accept header for
    /// endpoints whose 2xx response is a file download rather than JSON.
    func sendDataReturningResponse(
        endpoint: Endpoint,
        method: String,
        encodedBody: Data?,
        timeout: TimeInterval? = nil,
        accept: String = "application/json"
    ) async throws -> (Data, HTTPURLResponse) {
        if method != "GET" && method != "HEAD" {
            switch endpoint {
            case .login, .logout, .nativeOIDCStart, .nativeOIDCExchange, .nativeOIDCCancel: break
            default: try requireMutationAuthorization()
            }
        }
        var request = URLRequest(url: endpoint.url(relativeTo: baseURL))
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Slow server work (e.g. LLM commit-message generation) needs more than the
        // 60s session default, so callers can widen the per-request timeout.
        if let timeout { request.timeoutInterval = timeout }
        // Custom headers first, then built-ins so Accept/Content-Type always win.
        customHeaderProvider().apply(to: &request)
        AppConfig.applyClientIdentity(to: &request)
        request.setValue(accept, forHTTPHeaderField: "Accept")

        if let encodedBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = encodedBody
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(underlying: error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.http(statusCode: -1, body: nil)
        }

        if httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            throw APIError.http(
                statusCode: httpResponse.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }

        return (data, httpResponse)
    }

    func downloadData(
        from url: URL,
        using session: URLSession,
        mapsUnauthorized: Bool
    ) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Same-origin media (incl. the user's own server via the cookie-less
        // publicMediaSession) traverses the proxy, so it carries the custom
        // headers. But downloadData also fetches *external* transcript media
        // (third-party image URLs); those must NOT receive the headers, which may
        // be secrets — that would leak them off-origin. Built-in Accept set after
        // so it wins (#255).
        if Self.isSameOrigin(url, as: baseURL) {
            customHeaderProvider().apply(to: &request)
            AppConfig.applyClientIdentity(to: &request)
        }
        request.setValue("*/*", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(underlying: error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.http(statusCode: -1, body: nil)
        }

        if mapsUnauthorized && httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            throw APIError.http(
                statusCode: httpResponse.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }

        return data
    }

    public static func isSameOrigin(_ url: URL, as baseURL: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              let baseScheme = baseURL.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              let baseHost = baseURL.host?.lowercased()
        else {
            return false
        }

        return scheme == baseScheme
            && host == baseHost
            && normalizedPort(for: url) == normalizedPort(for: baseURL)
    }

    private static func normalizedPort(for url: URL) -> Int? {
        if let port = url.port {
            return port
        }

        switch url.scheme?.lowercased() {
        case "http":
            return 80
        case "https":
            return 443
        default:
            return nil
        }
    }
}

private extension APIClient {
    static func makeDefaultSession(
        delegate: URLSessionDelegate?,
        cookieStorage: HTTPCookieStorage
    ) -> URLSession {
        let configuration = URLSessionConfiguration.default
        #if DEBUG
        UITestURLSessionHook.configure(configuration)
        #endif
        configuration.httpCookieStorage = cookieStorage
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    static func makeDefaultPublicMediaSession(delegate: URLSessionDelegate?) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        #if DEBUG
        UITestURLSessionHook.configure(configuration)
        #endif
        configuration.httpCookieStorage = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }
}

private struct LoginRequest: Encodable {
    let password: String
}

private struct NativeOIDCStartRequest: Encodable {
    let callbackUrl: String
    let state: String
    let codeChallenge: String
    let codeChallengeMethod: String
}

private struct NativeOIDCExchangeRequest: Encodable {
    let flowId: String
    let code: String
    let state: String
    let codeVerifier: String
}

private struct NativeOIDCCancelRequest: Encodable {
    let flowId: String
    let state: String
}

private struct EmptyBody: Encodable {}

/// A `URLSession` redirect guard that removes the user's custom request headers
/// when the server redirects a **same-origin** request to a **cross-origin** host.
///
/// `APIClient` only attaches custom headers (e.g. `Authorization`, `X-Api-Key`)
/// to same-origin requests (#255). But if the server answers a same-origin
/// request with a 3xx redirect to another host, `URLSession` would by default
/// forward those headers to the new host. `URLSession` already strips
/// `Authorization` (and a few sensitive headers) on cross-origin redirects, so
/// the realistic residual leak is a non-`Authorization` custom header (e.g.
/// `X-Api-Key`) — which may be a secret. This delegate closes that gap (#277).
///
/// Same-origin → same-origin redirects keep the headers (a proxy path rewrite
/// still needs them); a request with no custom headers is left byte-identical.
/// Only `willPerformHTTPRedirection` is implemented, so every other delegate
/// responsibility (TLS trust, auth challenges) falls back to `URLSession`'s
/// default handling — unchanged from when these sessions had no delegate.
///
/// `@unchecked Sendable` is safe: both stored properties are immutable and
/// `Sendable` (the header provider is `@Sendable`); `NSObject` just isn't
/// `Sendable` on its own.
final class CrossOriginHeaderStripper: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let baseURL: URL
    private let customHeaderProvider: @Sendable () -> [CustomHeader]

    init(baseURL: URL, customHeaderProvider: @escaping @Sendable () -> [CustomHeader]) {
        self.baseURL = baseURL
        self.customHeaderProvider = customHeaderProvider
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        // Same-origin (or an indeterminate destination): follow the redirect with
        // headers untouched. We only strip when we can prove the hop is off-origin.
        guard let destination = request.url,
              !APIClient.isSameOrigin(destination, as: baseURL) else {
            completionHandler(request)
            return
        }

        // Cross-origin hop: drop every configured custom header by name so none of
        // the user's (possibly secret) headers reach the new host. Names match
        // case-insensitively because HTTP field names are case-insensitive.
        //
        // The strip set is read from the live config here — the same source that
        // applied the headers. If the user removed a header from the store between
        // a request being sent and its redirect arriving, that header's value could
        // slip through unstripped (a sub-second live-edit race; see #277 review).
        // Accepted as a known narrow gap; closing it would require carrying the
        // applied-name set through the redirect.
        var namesToStrip: Set<String> = ["cookie", AppConfig.clientIdentityHeaderName.lowercased()]
        namesToStrip.formUnion(
            customHeaderProvider()
                .filter { $0.isApplicable }
                .map { $0.sanitizedName.lowercased() }
        )
        guard !namesToStrip.isEmpty, let fields = request.allHTTPHeaderFields else {
            completionHandler(request)
            return
        }

        // Remove each matching header by its real (original-case) name. We clear
        // fields individually via `setValue(nil:)` rather than reassigning
        // `allHTTPHeaderFields`, because that setter merges new keys instead of
        // deleting omitted ones, so a filtered dictionary would not drop anything.
        var sanitized = request
        for name in fields.keys where namesToStrip.contains(name.lowercased()) {
            sanitized.setValue(nil, forHTTPHeaderField: name)
        }
        completionHandler(sanitized)
    }
}

/// Adapts clients that expose only `URLSessionConfiguration` (not a session
/// delegate) so they still use Talaria's cross-origin redirect guard.
final class CrossOriginRedirectGuardURLProtocol: URLProtocol, URLSessionDataDelegate, @unchecked Sendable {
    private struct Policy: @unchecked Sendable {
        let configuration: URLSessionConfiguration
        let stripper: CrossOriginHeaderStripper
    }

    private struct Lifecycle {
        var session: URLSession?
        var dataTask: URLSessionDataTask?
        var stripper: CrossOriginHeaderStripper?
        var isStopped = false
    }

    private static let policies = OSAllocatedUnfairLock(initialState: [String: Policy]())
    static var registeredPolicyCount: Int { policies.withLock { $0.count } }

    static func register(
        configuration: URLSessionConfiguration,
        baseURL: URL,
        customHeaders: [CustomHeader],
        builtInHeaders: [String: String]
    ) -> String {
        let policyHeader = "X-Talaria-Redirect-Policy-\(UUID().uuidString)"
        let protectedNames = Set(builtInHeaders.keys.map { $0.lowercased() })
        let effectiveCustomHeaders = customHeaders.filter {
            $0.isApplicable && !protectedNames.contains($0.sanitizedName.lowercased())
        }
        let innerConfiguration = configuration.copy() as? URLSessionConfiguration ?? .default
        innerConfiguration.protocolClasses = (innerConfiguration.protocolClasses ?? []).filter { $0 != Self.self }
        let policy = Policy(
            configuration: innerConfiguration,
            stripper: CrossOriginHeaderStripper(
                baseURL: baseURL,
                customHeaderProvider: { effectiveCustomHeaders }
            )
        )
        policies.withLock { $0[policyHeader.lowercased()] = policy }
        return policyHeader
    }

    static func unregister(_ policyHeader: String?) {
        guard let policyHeader else { return }
        _ = policies.withLock { $0.removeValue(forKey: policyHeader.lowercased()) }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        policy(for: request) != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static func policy(for request: URLRequest) -> (header: String, policy: Policy)? {
        guard let headerNames = request.allHTTPHeaderFields?.keys else { return nil }
        return policies.withLock { policies in
            for header in headerNames {
                if let policy = policies[header.lowercased()] {
                    return (header, policy)
                }
            }
            return nil
        }
    }

    private let lifecycleLock = NSRecursiveLock()
    private var lifecycle = Lifecycle()

    override func startLoading() {
        guard let match = Self.policy(for: request) else {
            lifecycleLock.withLock {
                guard !lifecycle.isStopped else { return }
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            }
            return
        }

        var forwarded = request
        forwarded.setValue(nil, forHTTPHeaderField: match.header)
        let task = lifecycleLock.withLock { () -> URLSessionDataTask? in
            guard !lifecycle.isStopped else { return nil }
            lifecycle.stripper = match.policy.stripper
            let session = URLSession(configuration: match.policy.configuration, delegate: self, delegateQueue: nil)
            lifecycle.session = session
            let task = session.dataTask(with: forwarded)
            lifecycle.dataTask = task
            return task
        }
        task?.resume()
    }

    override func stopLoading() {
        let resources = lifecycleLock.withLock { () -> (URLSessionDataTask?, URLSession?) in
            lifecycle.isStopped = true
            let resources = (lifecycle.dataTask, lifecycle.session)
            lifecycle.dataTask = nil
            lifecycle.session = nil
            lifecycle.stripper = nil
            return resources
        }
        resources.0?.cancel()
        resources.1?.invalidateAndCancel()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        lifecycleLock.withLock {
            guard !lifecycle.isStopped, let stripper = lifecycle.stripper else {
                completionHandler(nil)
                return
            }
            stripper.urlSession(
                session,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: request,
                completionHandler: completionHandler
            )
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let disposition = lifecycleLock.withLock { () -> URLSession.ResponseDisposition in
            guard !lifecycle.isStopped else { return .cancel }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            return lifecycle.isStopped ? .cancel : .allow
        }
        completionHandler(disposition)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lifecycleLock.withLock {
            guard !lifecycle.isStopped else { return }
            client?.urlProtocol(self, didLoad: data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let shouldInvalidate = lifecycleLock.withLock { () -> Bool in
            guard !lifecycle.isStopped else { return false }
            lifecycle.isStopped = true
            lifecycle.dataTask = nil
            lifecycle.session = nil
            lifecycle.stripper = nil
            if let error {
                client?.urlProtocol(self, didFailWithError: error)
            } else {
                client?.urlProtocolDidFinishLoading(self)
            }
            return true
        }
        if shouldInvalidate { session.finishTasksAndInvalidate() }
    }
}
