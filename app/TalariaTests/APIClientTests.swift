import XCTest
@testable import Talaria
@testable import TalariaKit

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

final class MockURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)
    static var requestHandler: Handler?
    /// A session whose configuration sends this header (see `register`) is served
    /// by its own handler, so a request that outlives its test — the completed-
    /// response title refresh, for example — can never reach the next test's
    /// global `requestHandler` (TAL-156).
    static let scopeHeader = "X-Talaria-Test-Handler"
    private static let scopedHandlerLock = NSLock()
    /// Newest last. Only the most recent sessions are kept: a request that outlives
    /// its test lands within the next few tests, and a scope dropped after that
    /// fails with `badServerResponse` instead of retaining test state for the rest
    /// of the runner process.
    private static var scopedHandlers: [(scope: String, handler: Handler)] = []
    private static let scopedHandlerLimit = 16

    /// Registers `handler` and returns the `scopeHeader` value that routes to it.
    static func register(_ handler: @escaping Handler) -> String {
        let scope = UUID().uuidString
        scopedHandlerLock.withLock {
            scopedHandlers.append((scope, handler))
            if scopedHandlers.count > scopedHandlerLimit {
                scopedHandlers.removeFirst()
            }
        }
        return scope
    }

    private static func handler(for request: URLRequest) -> Handler? {
        guard let scope = request.value(forHTTPHeaderField: scopeHeader) else { return requestHandler }
        return scopedHandlerLock.withLock { scopedHandlers.last { $0.scope == scope }?.handler }
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

final class MockURLProtocolScopeTests: APIClientTestCase {
    func testScopedHandlerOutlivesGlobalHandlerReplacement() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [
            MockURLProtocol.scopeHeader: MockURLProtocol.register { request in
                apiTestJSONResponse(#"{"session":{"session_id":"scoped"}}"#, for: request)
            }
        ]
        let client = APIClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration))

        // The next test's handler must not see this session's request.
        MockURLProtocol.requestHandler = { request in
            XCTFail("Scoped request leaked to the global handler: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let response = try await client.session(id: "scoped", includeMessages: false, messageLimit: nil)
        XCTAssertEqual(response.session?.sessionId, "scoped")

        // Registering many later sessions evicts this scope, so the retained
        // closure count stays bounded and the stale session fails cleanly.
        for _ in 0..<16 {
            _ = MockURLProtocol.register { _ in throw URLError(.badURL) }
        }
        do {
            _ = try await client.session(id: "scoped", includeMessages: false, messageLimit: nil)
            XCTFail("Evicted scope should not be served")
        } catch APIError.network(let underlying) {
            XCTAssertEqual((underlying as? URLError)?.code, .badServerResponse)
        }
    }
}

/// URLProtocol whose responses are completed manually so concurrent requests
/// can be answered out of order.
final class DeferredMockURLProtocol: URLProtocol {
    static var onRequest: ((DeferredMockURLProtocol) -> Void)?
    private static let handlerLock = NSLock()
    private static var handlersByHost: [String: (DeferredMockURLProtocol) -> Void] = [:]

    static func setOnRequest(_ handler: ((DeferredMockURLProtocol) -> Void)?, forHost host: String) {
        handlerLock.lock()
        defer { handlerLock.unlock() }
        handlersByHost[host] = handler
    }

    private static func handler(for request: URLRequest) -> ((DeferredMockURLProtocol) -> Void)? {
        handlerLock.lock()
        defer { handlerLock.unlock() }
        return request.url?.host.flatMap { handlersByHost[$0] } ?? onRequest
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

    override func stopLoading() {}

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
