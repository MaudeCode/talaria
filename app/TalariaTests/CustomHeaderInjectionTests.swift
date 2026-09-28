import XCTest
@testable import Talaria
@testable import TalariaKit

// MARK: - APIClient request injection

final class CustomHeaderAPIClientInjectionTests: APIClientTestCase {
    func testRequestsAdvertiseReleaseIdentityWithoutCustomHeaderSecrets() async throws {
        let (client, _) = makeHeaderClient([CustomHeader(name: "Authorization", value: "Bearer synthetic-secret")]) { request in
            let value = try XCTUnwrap(request.value(forHTTPHeaderField: "X-Talaria-Client"))
            let identity = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
            XCTAssertEqual(identity["version"] as? String, Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
            XCTAssertEqual(identity["buildNumber"] as? String, Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
            XCTAssertTrue(identity["sourceRevision"] is NSNull)
            XCTAssertTrue(identity["releaseSet"] is NSNull)
            let contracts = try XCTUnwrap(identity["contracts"] as? [String: Any])
            XCTAssertEqual(contracts["appWeb"] as? [Int], [1])
            XCTAssertEqual(contracts["appRelay"] as? [Int], [1])
            XCTAssertEqual(contracts["activityScene"] as? [String], ["activity_scene_v1"])
            XCTAssertFalse(value.contains("synthetic-secret"))
            return try self.ok(request)
        }
        _ = try? await client.sessions()
    }

    private func makeHeaderClient(
        _ customHeaders: [CustomHeader],
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> (client: APIClient, session: URLSession) {
        MockURLProtocol.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)

        let client = APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            customHeaderProvider: { customHeaders }
        )
        return (client, session)
    }

    private func ok(_ request: URLRequest, body: String = "{}") throws -> (HTTPURLResponse, Data) {
        let response = try XCTUnwrap(
            HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)
        )
        return (response, Data(body.utf8))
    }

    func testJSONRequestCarriesCustomHeadersAndBuiltInsWin() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer abc"),
            CustomHeader(name: "X-Api-Key", value: "k1"),
            CustomHeader(name: "Accept", value: "application/evil")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Api-Key"), "k1")
            // Built-in Accept is set after the custom headers, so it wins its key.
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            return try self.ok(request)
        }

        _ = try? await client.sessions()
    }

    func testEmptyHeaderListIsANoOp() async throws {
        let (client, _) = makeHeaderClient([]) { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            return try self.ok(request)
        }

        _ = try? await client.sessions()
    }

    func testWhitespaceOnlyHeaderNameIsSkipped() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "   ", value: "ghost"),
            CustomHeader(name: "X-Real", value: "ok")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Real"), "ok")
            // The blank-named row contributes nothing.
            XCTAssertEqual(request.allHTTPHeaderFields?.values.contains("ghost"), false)
            return try self.ok(request)
        }

        _ = try? await client.sessions()
    }

    func testUploadRequestCarriesCustomHeadersAndMultipartContentTypeWins() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer upload"),
            CustomHeader(name: "Content-Type", value: "application/evil")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer upload")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            // The built-in multipart Content-Type is set after the custom
            // headers, so it wins its key.
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary="),
                true
            )
            return try self.ok(request)
        }

        _ = try? await client.uploadFile(sessionID: "s1", data: Data("bytes".utf8), filename: "a.png")
    }

    func testTranscribeRequestCarriesCustomHeaders() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer stt")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer stt")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            return try self.ok(request)
        }

        _ = try? await client.transcribeAudio(data: Data("clip".utf8), filename: "v.m4a")
    }

    func testDownloadRequestCarriesCustomHeaders() async throws {
        let (client, session) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer media")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer media")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "*/*")
            return try self.ok(request, body: "binary")
        }

        _ = try? await client.downloadData(
            from: URL(string: "https://example.test/api/media?path=/x.png")!,
            using: session,
            mapsUnauthorized: false
        )
    }

    func testDownloadFromExternalOriginOmitsCustomHeaders() async throws {
        let (client, session) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer secret")
        ]) { request in
            // A third-party transcript image must never receive the (possibly
            // secret) custom headers — off-origin leak guard.
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Talaria-Client"))
            return try self.ok(request, body: "img")
        }

        _ = try? await client.downloadData(
            from: URL(string: "https://third-party.example/image.png")!,
            using: session,
            mapsUnauthorized: false
        )
    }
}

// MARK: - AuthManager configure / lifecycle

@MainActor
final class CustomHeaderAuthManagerTests: XCTestCase {
    private let cookieStorage = URLSessionConfiguration.ephemeral.httpCookieStorage!
    private let profileEntityCache = ProfileEntityCache(defaults: nil)

    private func makeManager(
        keychain: InMemoryKeychainStore,
        store: CustomHeaderStore,
        client: MockAuthAPIClient
    ) -> AuthManager {
        AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            headerStore: store,
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            serverRegistry: ServerRegistry.inMemory()
        )
    }

    func testConfigurePersistsHeadersOnSuccess() async throws {
        let keychain = InMemoryKeychainStore()
        let store = CustomHeaderStore()
        let manager = makeManager(
            keychain: keychain,
            store: store,
            client: MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false, loggedIn: false))
        )

        await manager.configure(
            serverURLString: "https://proxy.test",
            password: "",
            customHeaders: [CustomHeader(name: "Authorization", value: "Bearer abc")]
        )

        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://proxy.test"))))
        XCTAssertEqual(store.snapshot().map(\.name), ["Authorization"])
        // Headers persist under this server's scoped key, not a global one (#16).
        let saved = try XCTUnwrap(keychain.scopedValue(.customHeaders, scope: "https://proxy.test"))
        XCTAssertEqual([CustomHeader].decodeFromStorage(saved).map(\.value), ["Bearer abc"])
        XCTAssertNil(keychain.savedValues[.customHeaders])
    }

    func testPasskeyOnlyServerShowsSpecificMessageAndDoesNotLogIn() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, passwordAuthEnabled: false))
        let manager = makeManager(keychain: keychain, store: CustomHeaderStore(), client: client)

        await manager.configure(serverURLString: "https://example.test", password: "secret")

        XCTAssertEqual(manager.lastErrorMessage, AuthManager.passkeyOnlyMessage)
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertEqual(client.loginPasswords, [])
        XCTAssertNil(keychain.savedValues[.serverURL])
    }

    /// Trusted-header deployments — the reverse-proxy setups the custom-header
    /// feature exists for — authenticate at the proxy and answer
    /// `logged_in: true` with no password auth. Reading that as "passkeys" shut
    /// them out of a server they were already signed in to.
    func testTrustedHeaderServerThatAlreadySignedUsInIsSavedWithoutLogin() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(
            authEnabled: true,
            loggedIn: true,
            passwordAuthEnabled: false,
            trustedAuthEnabled: true
        ))
        let manager = makeManager(keychain: keychain, store: CustomHeaderStore(), client: client)

        await manager.configure(serverURLString: "https://example.test", password: "")

        XCTAssertNil(manager.lastErrorMessage)
        XCTAssertEqual(client.loginPasswords, [], "There is no credential to send.")
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://example.test"))))
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://example.test")
    }

    /// Browser and app cookie jars are separate, so external browser sign-in
    /// cannot be presented as a way to authenticate Talaria.
    func testOIDCServerReportsSingleSignOnRatherThanPasskeys() async throws {
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(
            authEnabled: true,
            loggedIn: false,
            passwordAuthEnabled: false,
            oidcEnabled: true
        ))
        let manager = makeManager(keychain: InMemoryKeychainStore(), store: CustomHeaderStore(), client: client)

        await manager.configure(serverURLString: "https://example.test", password: "")

        XCTAssertEqual(
            manager.lastErrorMessage,
            "This server signs in with single sign-on, which Talaria doesn't support yet."
        )
        XCTAssertNotEqual(manager.lastErrorMessage, AuthManager.passkeyOnlyMessage)
        XCTAssertEqual(manager.state, .unconfigured)
    }

    /// Trusted-header mode where the proxy did not authorize this request is a
    /// different problem again, with a different thing to try.
    func testTrustedHeaderServerWithoutASessionExplainsTheProxy() async throws {
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(
            authEnabled: true,
            loggedIn: false,
            passwordAuthEnabled: false,
            trustedAuthEnabled: true
        ))
        let manager = makeManager(keychain: InMemoryKeychainStore(), store: CustomHeaderStore(), client: client)

        await manager.configure(serverURLString: "https://example.test", password: "")

        XCTAssertEqual(manager.lastErrorMessage, AuthManager.trustedAuthNotSignedInMessage)
        XCTAssertEqual(manager.state, .unconfigured)
    }

    /// `addServer` carried a verbatim copy of the same inference and has to
    /// behave identically.
    func testAddServerAcceptsAServerThatAlreadySignedUsIn() async throws {
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(
            authEnabled: true,
            loggedIn: true,
            passwordAuthEnabled: false,
            trustedAuthEnabled: true
        ))
        let manager = AuthManager(
            keychain: InMemoryKeychainStore(),
            probeClientFactory: { _, _, _ in client },
            serverRegistry: ServerRegistry.inMemory()
        )

        let outcome = await manager.addServer(serverURLString: "https://example.test", password: "")

        XCTAssertEqual(outcome, .added(try XCTUnwrap(URL(string: "https://example.test"))))
        XCTAssertEqual(client.loginPasswords, [])
    }

    func testMissingPasswordFlagFallsThroughToPasswordLogin() async throws {
        let keychain = InMemoryKeychainStore()
        // authEnabled true but passwordAuthEnabled nil (older server) must NOT be
        // treated as passkey-only — the regression-safety rule from #255.
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = makeManager(keychain: keychain, store: CustomHeaderStore(), client: client)

        await manager.configure(serverURLString: "https://example.test", password: "secret")

        XCTAssertEqual(client.loginPasswords, ["secret"])
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://example.test"))))
        XCTAssertNil(manager.lastErrorMessage)
    }

    func testNoHeaderConfigureDoesNotPersistHeaderEntry() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = makeManager(keychain: keychain, store: CustomHeaderStore(), client: client)

        await manager.configure(serverURLString: "https://example.test", password: "secret")

        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://example.test"))))
        XCTAssertNil(keychain.scopedValue(.customHeaders, scope: "https://example.test"))
    }

    func testHeadersKeptOnSessionExpiryButClearedOnSignOut() async throws {
        let keychain = InMemoryKeychainStore()
        let store = CustomHeaderStore()
        let manager = makeManager(
            keychain: keychain,
            store: store,
            client: MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false, loggedIn: false))
        )

        await manager.configure(
            serverURLString: "https://proxy.test",
            password: "",
            customHeaders: [CustomHeader(name: "Authorization", value: "Bearer abc")]
        )
        XCTAssertNotNil(keychain.scopedValue(.customHeaders, scope: "https://proxy.test"))

        // Session-expiry keeps the headers so re-login behind the proxy still works.
        manager.handleAPIError(APIError.unauthorized)
        XCTAssertNotNil(keychain.scopedValue(.customHeaders, scope: "https://proxy.test"))
        XCTAssertEqual(store.snapshot().map(\.name), ["Authorization"])

        // Full sign-out forgets the server and its scoped headers.
        await manager.signOut()
        XCTAssertNil(keychain.scopedValue(.customHeaders, scope: "https://proxy.test"))
        XCTAssertEqual(store.snapshot(), [])
    }

    func testUpdateCustomHeadersDropsBlankRowsAndPersists() async throws {
        let keychain = InMemoryKeychainStore()
        let store = CustomHeaderStore()
        let manager = makeManager(
            keychain: keychain,
            store: store,
            client: MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false))
        )
        // The editor is reachable only while signed in, so establish an active
        // server first; headers then persist under that server's scoped key (#16).
        await manager.configure(serverURLString: "https://example.test", password: "")

        manager.updateCustomHeaders([
            CustomHeader(name: "X-Keep", value: "1"),
            CustomHeader(name: "   ", value: "ghost")
        ])

        XCTAssertEqual(store.snapshot().map(\.name), ["X-Keep"])
        XCTAssertEqual(
            [CustomHeader].decodeFromStorage(
                keychain.scopedValue(.customHeaders, scope: "https://example.test")
            ).map(\.name),
            ["X-Keep"]
        )
    }

    func testUpdateCustomHeadersWithoutPersistSkipsKeychain() async throws {
        let keychain = InMemoryKeychainStore()
        let store = CustomHeaderStore()
        let manager = makeManager(
            keychain: keychain,
            store: store,
            client: MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false))
        )
        await manager.configure(serverURLString: "https://example.test", password: "")

        // persist:false → live store refresh but no (slow) Keychain write.
        manager.updateCustomHeaders([CustomHeader(name: "X-Live", value: "1")], persist: false)
        XCTAssertEqual(store.snapshot().map(\.name), ["X-Live"])
        XCTAssertNil(keychain.scopedValue(.customHeaders, scope: "https://example.test"))

        // persist:true (editor dismissed) → now written to the Keychain.
        manager.updateCustomHeaders([CustomHeader(name: "X-Live", value: "1")], persist: true)
        XCTAssertNotNil(keychain.scopedValue(.customHeaders, scope: "https://example.test"))
    }

    func testLaunchMigratesLegacyGlobalHeadersToActiveServerScope() throws {
        let keychain = InMemoryKeychainStore()
        let encoded = try XCTUnwrap([CustomHeader(name: "Authorization", value: "Bearer saved")].encodedForStorage())
        // Pre-#16 state: one global header blob alongside the single saved server.
        try keychain.save(encoded, forKey: .customHeaders)
        try keychain.save("https://legacy.test", forKey: .serverURL)
        let store = CustomHeaderStore()

        _ = makeManager(
            keychain: keychain,
            store: store,
            client: MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false))
        )

        // On launch the blob is hydrated into the live snapshot, moved under the
        // saved server's scoped key, and the global remnant is removed (#16).
        XCTAssertEqual(store.snapshot().map(\.value), ["Bearer saved"])
        XCTAssertNotNil(keychain.scopedValue(.customHeaders, scope: "https://legacy.test"))
        XCTAssertNil(keychain.savedValues[.customHeaders])
    }
}
