// Shared by the package tests and the App-hosted TalariaTests, which compiles this file too (TAL-399).
import XCTest
@testable import TalariaKit

extension XCTestCase {
    /// Lets every main-actor task queued before this call run.
    @MainActor
    func drainMainActor() async {
        for _ in 0..<3 { await Task.yield() }
        await Task { @MainActor in }.value
    }
}

class APIClientTestCase: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func makeClient(
        cookiePersistence: (@Sendable () throws -> Void)? = nil,
        forgetProfileOwner: (@Sendable () throws -> Void)? = nil,
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> APIClient {
        MockURLProtocol.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)

        return APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            cookiePersistence: cookiePersistence,
            forgetProfileOwner: forgetProfileOwner
        )
    }

    func makeFilePreviewSession() throws -> SessionSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            SessionSummary.self,
            from: Data("""
            {
              "session_id": "session-abc",
              "title": "Planning",
              "workspace": "/tmp/workspace"
            }
            """.utf8)
        )
    }
}

/// A stub's test-owned value, written by the test and read on `URLSession`'s thread.
/// `@unchecked Sendable`: `lock` guards `stored`.
final class LockedTestValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
        _modify {
            lock.lock()
            defer { lock.unlock() }
            yield &stored
        }
    }
}

final class MockURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)
    private static let requestHandlerStorage = LockedTestValue<Handler?>(nil)
    static var requestHandler: Handler? {
        get { requestHandlerStorage.value }
        set { requestHandlerStorage.value = newValue }
    }
    /// A session whose configuration sends this header (see `register`) is served
    /// by its own handler, so a request that outlives its test — the completed-
    /// response title refresh, for example — can never reach the next test's
    /// global `requestHandler` (TAL-156).
    static let scopeHeader = "X-Talaria-Test-Handler"
    /// Newest last. Only the most recent sessions are kept: a request that outlives
    /// its test lands within the next few tests, and a scope dropped after that
    /// fails with `badServerResponse` instead of retaining test state for the rest
    /// of the runner process.
    private static let scopedHandlers = LockedTestValue<[(scope: String, handler: Handler)]>([])
    private static let scopedHandlerLimit = 16

    /// Registers `handler` and returns the `scopeHeader` value that routes to it.
    static func register(_ handler: @escaping Handler) -> String {
        let scope = UUID().uuidString
        scopedHandlers.value = (scopedHandlers.value + [(scope, handler)]).suffix(scopedHandlerLimit)
        return scope
    }

    private static func handler(for request: URLRequest) -> Handler? {
        guard let scope = request.value(forHTTPHeaderField: scopeHeader) else { return requestHandler }
        return scopedHandlers.value.last { $0.scope == scope }?.handler
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let requestHandler = Self.handler(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let (response, data) = try requestHandler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

/// URLProtocol whose responses are completed manually so concurrent requests
/// can be answered out of order.
final class DeferredMockURLProtocol: URLProtocol {
    private static let onRequestStorage = LockedTestValue<((DeferredMockURLProtocol) -> Void)?>(nil)
    static var onRequest: ((DeferredMockURLProtocol) -> Void)? {
        get { onRequestStorage.value }
        set { onRequestStorage.value = newValue }
    }
    private static let handlersByHost = LockedTestValue<[String: (DeferredMockURLProtocol) -> Void]>([:])

    static func setOnRequest(_ handler: ((DeferredMockURLProtocol) -> Void)?, forHost host: String) {
        handlersByHost.value[host] = handler
    }

    private static func handler(for request: URLRequest) -> ((DeferredMockURLProtocol) -> Void)? {
        request.url?.host.flatMap { handlersByHost.value[$0] } ?? onRequest
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let onRequest = Self.handler(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        onRequest(self)
    }

    private let stopped = LockedTestValue(false)
    /// True once the client cancelled the request.
    var isStopped: Bool { stopped.value }

    override func stopLoading() {
        stopped.value = true
    }

    func complete(withJSON json: String, statusCode: Int = 200) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    func fail(with error: Error) {
        client?.urlProtocol(self, didFailWithError: error)
    }
}

final class DeferredRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [DeferredMockURLProtocol] = []

    func append(_ request: DeferredMockURLProtocol) -> Int {
        lock.lock()
        defer { lock.unlock() }
        pending.append(request)
        return pending.count
    }

    func request(at index: Int) -> DeferredMockURLProtocol {
        lock.lock()
        defer { lock.unlock() }
        return pending[index]
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }
}

/// Holds every request and answers them one round trip at a time (TAL-839): a round trip is the requests that
/// start together, so requests sent one after another take one round trip each.
final class HeldRoundTrips: Sendable {
    private let requests = DeferredRequests()
    private let answered = LockedTestValue(0)

    func hold(_ request: DeferredMockURLProtocol) {
        _ = requests.append(request)
    }

    /// The requests that started since the last round trip: it waits for one, then until none starts for `quiet`.
    /// Empty when none starts before `timeout`, or as soon as `isDone` while none is pending.
    func nextRoundTrip(
        quiet: Duration = .milliseconds(200),
        timeout: Duration = .seconds(3),
        isDone: @MainActor () -> Bool = { false }
    ) async -> [DeferredMockURLProtocol] {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        let start = answered.value
        var seen = requests.count
        var lastStart = clock.now
        while clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
            let count = requests.count
            if count != seen {
                seen = count
                lastStart = clock.now
            } else if count > start, clock.now - lastStart >= quiet {
                break
            } else if count == start, await isDone() {
                break
            }
        }
        answered.value = seen
        return (start..<seen).map(requests.request(at:))
    }
}

extension DeferredMockURLProtocol {
    var path: String { request.url?.path ?? "" }
}

final class InMemoryKeychainStore: KeychainStoring {
    private(set) var savedValues: [KeychainStore.Key: String] = [:]
    var saveError: Error?
    var saveErrors: [KeychainStore.Key: Error] = [:]
    /// Scoped reads of these keys throw, so tests can prove a failed read is
    /// never treated as an absent value (TAL-91).
    var scopedLoadErrors: [KeychainStore.Key: Error] = [:]
    /// Per-key write count, so tests can assert no redundant writes occur.
    private(set) var saveCounts: [KeychainStore.Key: Int] = [:]
    /// Per-server-scoped storage, keyed by the same "raw::scope" string the real
    /// `KeychainStore` uses, so tests can assert on per-server credential keys (#16).
    private(set) var scopedValues: [String: String] = [:]

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        if let error = saveErrors[key] ?? saveError { throw error }
        savedValues[key] = value
        saveCounts[key, default: 0] += 1
    }

    func load(_ key: KeychainStore.Key) throws -> String? {
        savedValues[key]
    }

    func delete(_ key: KeychainStore.Key) throws {
        savedValues.removeValue(forKey: key)
    }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        if let error = saveErrors[key] ?? saveError { throw error }
        scopedValues[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        if let error = scopedLoadErrors[key] { throw error }
        return scopedValues[KeychainStore.scopedKey(key, scope: scope)]
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        scopedValues.removeValue(forKey: KeychainStore.scopedKey(key, scope: scope))
    }

    /// Convenience for assertions: the scoped value stored for `key` under `scope`.
    func scopedValue(_ key: KeychainStore.Key, scope: String) -> String? {
        scopedValues[KeychainStore.scopedKey(key, scope: scope)]
    }
}

// Test double: mutable counters are only ever touched serially (each call is
// awaited before the next), so unchecked Sendable conformance is safe here.
final class MockAuthAPIClient: AuthAPIClient, @unchecked Sendable {
    /// How `logout()` should behave, so tests can exercise sign-out against an
    /// unreachable (`fail`) or hung (`hang`) server, not just a happy path.
    enum LogoutBehavior {
        case succeed
        case fail(Error)
        case hang
    }

    var authStatusResponse: AuthStatusResponse
    var loginResponse: LoginResponse
    var authStatusError: Error?
    var authStatusDelay: Duration?
    private(set) var authStatusCallCount = 0
    private let logoutBehavior: LogoutBehavior
    private(set) var loginPasswords: [String] = []
    private(set) var logoutCallCount = 0

    init(
        authStatus: AuthStatusResponse,
        loginResponse: LoginResponse = LoginResponse(ok: true, message: nil, error: nil),
        logoutBehavior: LogoutBehavior = .succeed
    ) {
        self.authStatusResponse = authStatus
        self.loginResponse = loginResponse
        self.logoutBehavior = logoutBehavior
    }

    func health() async throws -> HealthResponse {
        HealthResponse(status: "ok", sessions: nil, activeStreams: nil, uptimeSeconds: nil)
    }

    func authStatus() async throws -> AuthStatusResponse {
        authStatusCallCount += 1
        if let authStatusDelay { try await Task.sleep(for: authStatusDelay) }
        if let authStatusError { throw authStatusError }
        return authStatusResponse
    }

    func login(password: String) async throws -> LoginResponse {
        loginPasswords.append(password)
        return loginResponse
    }

    func logout() async throws -> LoginResponse {
        logoutCallCount += 1
        switch logoutBehavior {
        case .succeed:
            return LoginResponse(ok: true, message: nil, error: nil)
        case .fail(let error):
            throw error
        case .hang:
            // Block until the caller's timeout cancels this task, mimicking a
            // server that accepts the connection but never responds.
            try await Task.sleep(for: .seconds(3600))
            return LoginResponse(ok: true, message: nil, error: nil)
        }
    }
}

func apiTestJSONResponse(
    _ json: String,
    statusCode: Int = 200,
    for request: URLRequest
) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
        url: request.url!,
        statusCode: statusCode,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
    )!

    return (response, Data(json.utf8))
}

func apiTestBodyData(from request: URLRequest) -> Data? {
    if let httpBody = request.httpBody {
        return httpBody
    }

    guard let stream = request.httpBodyStream else {
        return nil
    }

    stream.open()
    defer { stream.close() }

    var data = Data()
    let bufferSize = 1024
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
    defer { buffer.deallocate() }

    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: bufferSize)
        if count < 0 {
            return nil
        }
        if count == 0 {
            break
        }
        data.append(buffer, count: count)
    }

    return data
}

func apiTestMultipartFilename(from request: URLRequest) throws -> String {
    let data = try XCTUnwrap(apiTestBodyData(from: request))
    let body = try XCTUnwrap(String(data: data, encoding: .utf8))
    let marker = try XCTUnwrap(body.range(of: "filename=\""))
    let afterMarker = body[marker.upperBound...]
    let end = try XCTUnwrap(afterMarker.firstIndex(of: "\""))
    return String(afterMarker[..<end])
}

func apiTestJSONBody(from request: URLRequest) throws -> [String: Any] {
    let data = try XCTUnwrap(apiTestBodyData(from: request))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// A `URLProtocol` that issues exactly one 3xx redirect for a configured source
/// path, then serves a 200 for every other request — capturing the request of
/// the hop *after* the redirect ("second hop") so a test can assert which headers
/// survived. It carries the first request's headers onto the follow-up to mimic a
/// server redirect; `URLSession` then consults the session's redirect delegate
/// (the system under test), which is what must strip them.
final class RedirectingMockURLProtocol: URLProtocol {
    struct Redirect {
        let fromPath: String
        let to: URL
    }

    private struct State {
        var redirect: Redirect?
        var firstHopRequest: URLRequest?
        var secondHopRequest: URLRequest?
        var responseData = Data("{}".utf8)
    }

    private static let state = LockedTestValue(State())

    static var redirect: Redirect? {
        get { state.value.redirect }
        set { state.value.redirect = newValue }
    }
    /// The request seen by the mocked origin before it emits the redirect.
    static var firstHopRequest: URLRequest? {
        get { state.value.firstHopRequest }
        set { state.value.firstHopRequest = newValue }
    }
    /// The request `URLSession` issued for the hop after the redirect.
    static var secondHopRequest: URLRequest? {
        get { state.value.secondHopRequest }
        set { state.value.secondHopRequest = newValue }
    }
    static var responseData: Data {
        get { state.value.responseData }
        set { state.value.responseData = newValue }
    }

    static func reset() {
        state.value = State()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let redirect = Self.redirect, request.url?.path == redirect.fromPath {
            Self.firstHopRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 302,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": redirect.to.absoluteString]
            )!
            var followUp = URLRequest(url: redirect.to)
            followUp.httpMethod = request.httpMethod
            followUp.allHTTPHeaderFields = request.allHTTPHeaderFields
            client?.urlProtocol(self, wasRedirectedTo: followUp, redirectResponse: response)
            return
        }

        Self.secondHopRequest = request
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A shared App/Web contract fixture from the repository's `contracts/fixtures/<name>.json`.
func sharedContractFixture(_ name: String) throws -> Data {
    // app/TalariaKit/Tests/TalariaKitTests/Support/<file> -> repository root
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    return try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/\(name).json"))
}

/// One recorded server body from `contracts/fixtures/execution-modes.json` (TAL-1045), as JSON.
func executionModesFixture(_ key: String) throws -> String {
    let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("execution-modes")) as? [String: Any])
    return String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(fixture[key])), as: UTF8.self)
}
