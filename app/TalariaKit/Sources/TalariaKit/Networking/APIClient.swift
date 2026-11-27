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

    public nonisolated let baseURL: URL
    let session: URLSession
    let publicMediaSession: URLSession
    /// The redirect guard every request carries as its task delegate. Strips the
    /// user's custom headers when the server redirects a same-origin request to a
    /// cross-origin host (#277). It rides on each task rather than the session
    /// because the default sessions are shared by every client (TAL-847).
    /// `nonisolated` so tests can drive the exact delegate the client installs;
    /// it is immutable and `Sendable`.
    nonisolated let redirectHeaderStripper: CrossOriginHeaderStripper
    /// The session this client built for an injected cookie jar (a sign-in
    /// probe's throwaway jar), invalidated in `deinit`. Shared and injected
    /// sessions are never invalidated by a client.
    private let privateSession: URLSession?
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
    /// The widget's quota snapshot, cleared by a successful profile switch.
    let quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore

    public init(
        baseURL: URL,
        session: URLSession? = nil,
        publicMediaSession: URLSession? = nil,
        cookieStorage: HTTPCookieStorage? = nil,
        cookiePersistence: (@Sendable () throws -> Void)? = nil,
        forgetProfileOwner: (@Sendable () throws -> Void)? = nil,
        customHeaderProvider: @escaping @Sendable () -> [CustomHeader] = { CustomHeaderStore.shared.snapshot() },
        quotaSnapshotStore: ProviderQuotaWidgetSnapshotStore = ProviderQuotaWidgetSnapshotStore()
    ) {
        self.baseURL = baseURL
        self.customHeaderProvider = customHeaderProvider
        self.quotaSnapshotStore = quotaSnapshotStore

        // One redirect guard for every request (same origin + same header
        // provider), so a server-issued same-origin → cross-origin redirect can't
        // forward the user's custom headers off-origin (#277).
        let redirectHeaderStripper = CrossOriginHeaderStripper(
            baseURL: baseURL,
            customHeaderProvider: customHeaderProvider
        )
        self.redirectHeaderStripper = redirectHeaderStripper

        let resolvedCookieStorage = cookieStorage
            ?? session?.configuration.httpCookieStorage
            ?? ServerCookieStore.shared.storage(for: baseURL)
        // Clients for one server share its warm connection pool and cookie jar;
        // an injected jar gets a session of its own (TAL-847).
        let privateSession = session == nil && cookieStorage != nil
            ? Self.makeDefaultSession(cookieStorage: resolvedCookieStorage)
            : nil
        self.session = session ?? privateSession ?? SharedURLSessions.defaultSession(
            for: baseURL,
            cookieStorage: resolvedCookieStorage
        )
        self.privateSession = privateSession
        self.publicMediaSession = publicMediaSession ?? SharedURLSessions.publicMediaSession()
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
        self.decoder = Self.responseDecoder()

        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        self.encoder = encoder
    }

    deinit {
        // `finishTasksAndInvalidate` lets any in-flight request finish first; by
        // deinit there should be none, since an in-flight actor call keeps `self` alive.
        privateSession?.finishTasksAndInvalidate()
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

    /// The decoder for every server response, live or cached (`ResponseCache`).
    static func responseDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    /// A GET whose raw response also lands in `cache`, so the next launch can show it first
    /// (TAL-437). Only a response that decoded is kept.
    func send<Response: Decodable>(
        endpoint: Endpoint,
        caching cache: ResponseCache.Entry?
    ) async throws -> Response {
        let data = try await sendData(endpoint: endpoint, method: "GET", encodedBody: nil)
        let response = try decode(Response.self, from: data)
        cache?.save(data)
        return response
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
        accept: String = "application/json",
        contentType: String = "application/json"
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
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = encodedBody
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request, delegate: redirectHeaderStripper)
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
        let request = downloadRequest(from: url, accept: "*/*")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request, delegate: redirectHeaderStripper)
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

    /// Lets URLSession write the response to disk before transferring ownership to the share sheet.
    func downloadPrivateZIP(from url: URL, filename: String) async throws -> URL {
        let request = downloadRequest(from: url, accept: "application/zip")
        let redirectGuard = CrossOriginHeaderStripper(
            baseURL: baseURL, customHeaderProvider: customHeaderProvider, allowsCrossOrigin: false
        )
        let temporaryFile: URL
        let response: URLResponse
        do {
            (temporaryFile, response) = try await session.download(for: request, delegate: redirectGuard)
        } catch {
            throw APIError.network(underlying: error)
        }

        let files = FileManager.default
        defer { try? files.removeItem(at: temporaryFile) }
        try Task.checkCancellation()
        let http = response as? HTTPURLResponse
        if http?.statusCode == 401 { throw APIError.unauthorized }
        guard http?.statusCode == 200, http?.mimeType == "application/zip" else {
            throw APIError.http(statusCode: http?.statusCode ?? -1, body: nil)
        }

        let directory = files.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let archive = directory.appending(path: filename)
        do {
            var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
            #if os(iOS)
            attributes[.protectionKey] = FileProtectionType.complete
            #endif
            try files.setAttributes(attributes, ofItemAtPath: temporaryFile.path)
            try files.moveItem(at: temporaryFile, to: archive)
            return archive
        } catch {
            try? files.removeItem(at: directory)
            throw error
        }
    }

    private func downloadRequest(from url: URL, accept: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // The user's proxy headers stay on their server, even when fetching external transcript media.
        if Self.isSameOrigin(url, as: baseURL) {
            customHeaderProvider().apply(to: &request)
            AppConfig.applyClientIdentity(to: &request)
        }
        request.setValue(accept, forHTTPHeaderField: "Accept")
        return request
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

extension APIClient {
    /// No session delegate: the redirect guard rides on each task (TAL-847).
    static func makeDefaultSession(cookieStorage: HTTPCookieStorage) -> URLSession {
        let configuration = URLSessionConfiguration.default
        #if DEBUG
        UITestURLSessionHook.configure(configuration)
        #endif
        configuration.httpCookieStorage = cookieStorage
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        return URLSession(configuration: configuration)
    }

    static func makeDefaultPublicMediaSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        #if DEBUG
        UITestURLSessionHook.configure(configuration)
        #endif
        configuration.httpCookieStorage = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration)
    }
}

/// The sessions `APIClient`s share, so a new client reuses warm connections
/// instead of paying a fresh TCP and TLS handshake (TAL-847). Default sessions
/// are keyed by the server's cookie scope and carry that server's
/// `ServerCookieStore` jar, so cookies stay per server; the cookie-less media
/// session is process-wide. They are never invalidated: `ServerCookieStore.clear`
/// empties the same jar object, so a cached session stays valid after sign-out.
enum SharedURLSessions {
    private struct Cache {
        var hookGeneration = 0
        var defaults: [String: URLSession] = [:]
        var media: URLSession?
    }

    private static let cache = OSAllocatedUnfairLock(initialState: Cache())

    static func defaultSession(for server: URL, cookieStorage: HTTPCookieStorage) -> URLSession {
        let scope = ServerCookieStore.scopeURL(for: server).absoluteString
        return withCurrentCache { cache in
            if let session = cache.defaults[scope] { return session }
            let session = APIClient.makeDefaultSession(cookieStorage: cookieStorage)
            cache.defaults[scope] = session
            return session
        }
    }

    static func publicMediaSession() -> URLSession {
        withCurrentCache { cache in
            if let session = cache.media { return session }
            let session = APIClient.makeDefaultPublicMediaSession()
            cache.media = session
            return session
        }
    }

    private static func withCurrentCache(_ body: (inout Cache) -> URLSession) -> URLSession {
        cache.withLockUnchecked { cache in
            #if DEBUG
            // Tests swap the hook to route sessions through a mock protocol;
            // sessions built under an earlier hook would bypass it.
            let generation = UITestURLSessionHook.generation
            if cache.hookGeneration != generation { cache = Cache(hookGeneration: generation) }
            #endif
            return body(&cache)
        }
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

struct EmptyBody: Encodable {}

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
/// A cross-origin hop is followed only as a bodiless GET or HEAD; any other
/// method, body, or body stream is refused rather than replayed (TAL-1406).
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
    private let allowsCrossOrigin: Bool

    init(baseURL: URL, customHeaderProvider: @escaping @Sendable () -> [CustomHeader], allowsCrossOrigin: Bool = true) {
        self.baseURL = baseURL
        self.customHeaderProvider = customHeaderProvider
        self.allowsCrossOrigin = allowsCrossOrigin
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

        // Cross-origin hop that would replay a request body (a 307/308 keeps the
        // method and body: a sign-in password, OIDC code, upload, or recording).
        // Refuse it, so `URLSession` delivers the 3xx itself and nothing reaches
        // the other origin; callers see their usual non-2xx `APIError.http`.
        let method = request.httpMethod?.uppercased() ?? "GET"
        guard allowsCrossOrigin, method == "GET" || method == "HEAD",
              request.httpBody == nil,
              request.httpBodyStream == nil else {
            completionHandler(nil)
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
