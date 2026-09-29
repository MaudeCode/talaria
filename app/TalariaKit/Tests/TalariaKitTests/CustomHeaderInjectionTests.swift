import XCTest
@testable import TalariaKit

// MARK: - Model, storage, and store

final class CustomHeaderModelTests: XCTestCase {
    func testStampedReleaseIdentityRejectsMismatchedBuildAndIgnoresUnrelatedMetadata() throws {
        let source = String(repeating: "a", count: 40)
        var info: [String: Any] = [
            "CFBundleShortVersionString": "2.1.0", "CFBundleVersion": "321",
            "secret": "synthetic-secret",
            "TalariaRelease": ["version": "2.1.0", "buildNumber": 321,
                               "sourceRevision": source, "releaseSet": source,
                               "contracts": ["appWeb": [1], "appRelay": [1], "activityScene": ["activity_scene_v1"]]]
        ]
        let encoded = try AppConfig.releaseIdentity(info: info)
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any])
        XCTAssertEqual(metadata["sourceRevision"] as? String, source)
        XCTAssertEqual(metadata["releaseSet"] as? String, source)
        XCTAssertFalse(encoded.contains("synthetic-secret"))
        info["CFBundleVersion"] = "322"
        let mismatched = try AppConfig.releaseIdentity(info: info)
        let rejected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(mismatched.utf8)) as? [String: Any])
        XCTAssertTrue(rejected["sourceRevision"] is NSNull)
        XCTAssertTrue(rejected["releaseSet"] is NSNull)
        info["CFBundleVersion"] = "321"
        var invalid = try XCTUnwrap(info["TalariaRelease"] as? [String: Any])
        invalid["sourceRevision"] = source + "\n"
        invalid["releaseSet"] = source + "\n"
        info["TalariaRelease"] = invalid
        let malformed = try AppConfig.releaseIdentity(info: info)
        let missing = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(malformed.utf8)) as? [String: Any])
        XCTAssertTrue(missing["sourceRevision"] is NSNull)
    }

    func testStorageRoundTripPreservesNameAndValueAndOrder() throws {
        let headers = [
            CustomHeader(name: "Authorization", value: "Bearer abc"),
            CustomHeader(name: "X-Api-Key", value: "k1")
        ]

        let encoded = try XCTUnwrap(headers.encodedForStorage())
        let decoded = [CustomHeader].decodeFromStorage(encoded)

        XCTAssertEqual(decoded, headers)
        XCTAssertEqual(decoded.map(\.name), ["Authorization", "X-Api-Key"])
        XCTAssertEqual(decoded.map(\.value), ["Bearer abc", "k1"])
    }

    func testEmptyListEncodesToNilAndGarbageDecodesToEmpty() {
        XCTAssertNil([CustomHeader]().encodedForStorage())
        XCTAssertEqual([CustomHeader].decodeFromStorage(nil), [])
        XCTAssertEqual([CustomHeader].decodeFromStorage("not json"), [])
        XCTAssertEqual([CustomHeader].decodeFromStorage(#"{"unexpected":true}"#), [])
    }

    func testDecodeIsTolerantOfMissingField() {
        // A row missing "value" decodes with an empty value rather than dropping
        // the whole list (tolerant decoding rule).
        let decoded = [CustomHeader].decodeFromStorage(#"[{"name":"X-Only-Name"}]"#)

        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded.first?.name, "X-Only-Name")
        XCTAssertEqual(decoded.first?.value, "")
    }

    func testIsApplicableRejectsBlankNamesAndNewlineInjection() {
        XCTAssertFalse(CustomHeader(name: "   ", value: "x").isApplicable)
        XCTAssertFalse(CustomHeader(name: "X-Inject\nEvil", value: "x").isApplicable)
        XCTAssertFalse(CustomHeader(name: "X-Ok", value: "line1\nline2").isApplicable)
        XCTAssertTrue(CustomHeader(name: "  X-Trim  ", value: "  Bearer spaced  ").isApplicable)
    }

    func testIsApplicableRejectsNonTokenHeaderNames() {
        XCTAssertFalse(CustomHeader(name: "X Bad", value: "v").isApplicable)        // space
        XCTAssertFalse(CustomHeader(name: "X:Bad", value: "v").isApplicable)        // colon
        XCTAssertFalse(CustomHeader(name: "Aut\u{007F}h", value: "v").isApplicable) // control char
        XCTAssertTrue(CustomHeader(name: "X-Api-Key", value: "v").isApplicable)
        // Internal spaces are fine in a value (e.g. "Bearer <token>").
        XCTAssertTrue(CustomHeader(name: "Authorization", value: "Bearer a b c").isApplicable)
    }

    func testSanitizedForStorageDropsBlankNameRowsOnly() {
        let headers = [
            CustomHeader(name: "X-Keep", value: "1"),
            CustomHeader(name: "   ", value: "ghost"),
            CustomHeader(name: "", value: "")
        ]

        XCTAssertEqual(headers.sanitizedForStorage().map(\.name), ["X-Keep"])
    }

    func testStoreSnapshotReflectsReplace() {
        let store = CustomHeaderStore()
        XCTAssertEqual(store.snapshot(), [])

        store.replace(with: [CustomHeader(name: "A", value: "1")])
        XCTAssertEqual(store.snapshot().map(\.name), ["A"])

        store.replace(with: [])
        XCTAssertEqual(store.snapshot(), [])
    }

    func testMergedUnderBuiltInsLetsBuiltInsWin() {
        let merged = [
            CustomHeader(name: "accept", value: "application/evil"),
            CustomHeader(name: "Authorization", value: "Bearer abc")
        ].merged(under: ["Accept": "text/event-stream"])

        XCTAssertEqual(merged["Accept"], "text/event-stream")
        XCTAssertNil(merged["accept"])
        XCTAssertEqual(merged["Authorization"], "Bearer abc")
    }
}

// MARK: - AuthStatusResponse tolerant decode

final class CustomHeaderAuthStatusDecodeTests: XCTestCase {
    private func decode(_ json: String) throws -> AuthStatusResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(AuthStatusResponse.self, from: Data(json.utf8))
    }

    func testDecodesNewCapabilityFlags() throws {
        let status = try decode(
            """
            {
              "auth_enabled": true,
              "password_auth_enabled": false,
              "passkeys_enabled": true,
              "passwordless_enabled": true,
              "oidc_native_handoff_enabled": true
            }
            """
        )

        XCTAssertEqual(status.authEnabled, true)
        XCTAssertEqual(status.passwordAuthEnabled, false)
        XCTAssertEqual(status.passkeysEnabled, true)
        XCTAssertEqual(status.passwordlessEnabled, true)
        XCTAssertEqual(status.oidcNativeHandoffEnabled, true)
    }

    func testMissingNewFlagsDecodeToNil() throws {
        let status = try decode(#"{"auth_enabled": true}"#)

        XCTAssertEqual(status.authEnabled, true)
        XCTAssertNil(status.passwordAuthEnabled)
        XCTAssertNil(status.passkeysEnabled)
        XCTAssertNil(status.passwordlessEnabled)
        XCTAssertNil(status.oidcNativeHandoffEnabled)
    }

    func testUnknownFieldsAreIgnored() throws {
        let status = try decode(#"{"auth_enabled": false, "future_field": "x"}"#)

        XCTAssertEqual(status.authEnabled, false)
        XCTAssertNil(status.passwordAuthEnabled)
    }
}

// MARK: - SSE stream injection

@MainActor
final class CustomHeaderSSEInjectionTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testSSEStreamCarriesCustomHeadersUnderBuiltIns() async throws {
        let captured = expectation(description: "sse request captured")
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sse")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            // Built-in Accept must win over a user-supplied Accept.
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
            captured.fulfill()

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, Data("event: stream_end\ndata: {}\n\n".utf8))
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let client = SSEClient(
            urlSessionConfiguration: configuration,
            customHeaderProvider: {
                [
                    CustomHeader(name: "Authorization", value: "Bearer sse"),
                    CustomHeader(name: "x-talaria-client", value: "forged"),
                    CustomHeader(name: "Accept", value: "application/evil")
                ]
            }
        )

        client.start(url: URL(string: "https://example.test/api/chat/stream?stream_id=s1")!) { _ in }
        await fulfillment(of: [captured], timeout: 10)
        client.stop()
    }

    /// The default SSE header provider reads `CustomHeaderStore.shared`, which holds
    /// only the active server's headers (#16) — so the stream carries the active
    /// server's proxy header, never another configured server's.
    func testSSEStreamSourcesHeadersFromActiveServerStore() async throws {
        let previous = CustomHeaderStore.shared.snapshot()
        defer { CustomHeaderStore.shared.replace(with: previous) }
        CustomHeaderStore.shared.replace(with: [CustomHeader(name: "Authorization", value: "Bearer active-a")])

        let streamURL = try XCTUnwrap(URL(string: "https://a-\(UUID().uuidString).test/api/chat/stream?stream_id=s1"))
        let cookieStorage = ServerCookieStore.shared.storage(for: streamURL)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: try XCTUnwrap(streamURL.host),
            .path: "/",
            .name: "hermes_session",
            .value: "active-cookie"
        ]))
        cookieStorage.setCookie(cookie)
        defer { cookieStorage.deleteCookie(cookie) }

        let captured = expectation(description: "sse request captured")
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer active-a")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "hermes_session=active-cookie")
            captured.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, Data("event: stream_end\ndata: {}\n\n".utf8))
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        // No explicit provider → uses the default active-server store.
        let client = SSEClient(urlSessionConfiguration: configuration)

        client.start(url: streamURL) { _ in }
        await fulfillment(of: [captured], timeout: 10)
        client.stop()
    }

    /// Verify exact server URLs get independent jars, even on one hostname.
    func testSSECookieJarIsPortIsolatedPerStreamURL() throws {
        let nonce = UUID().uuidString.lowercased()
        let host = "same-\(nonce).test"
        let streamA = try XCTUnwrap(URL(string: "https://\(host):8443/api/chat/stream?stream_id=s1"))
        let streamB = try XCTUnwrap(URL(string: "https://\(host):9443/api/chat/stream?stream_id=s1"))
        let storageA = ServerCookieStore.shared.storage(for: streamA)
        let storageB = ServerCookieStore.shared.storage(for: streamB)

        func sessionCookie(host: String, value: String) throws -> HTTPCookie {
            try XCTUnwrap(HTTPCookie(properties: [
                .domain: host, .path: "/", .name: "hermes_session", .value: value
            ]))
        }
        let cookieA = try sessionCookie(host: host, value: "a-cookie")
        let cookieB = try sessionCookie(host: host, value: "b-cookie")
        storageA.setCookie(cookieA)
        storageB.setCookie(cookieB)
        defer {
            storageA.deleteCookie(cookieA)
            storageB.deleteCookie(cookieB)
        }

        XCTAssertEqual(storageA.cookies(for: streamA)?.map(\.value), ["a-cookie"])
        XCTAssertEqual(storageB.cookies(for: streamB)?.map(\.value), ["b-cookie"])
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

// MARK: - Cross-origin redirect header stripping (#277)

final class CrossOriginRedirectHeaderTests: XCTestCase {
    private let baseURL = URL(string: "https://example.test")!

    override func tearDown() {
        RedirectingMockURLProtocol.reset()
        super.tearDown()
    }

    /// Drives the production guard's redirect decision directly: hands it a
    /// synthetic `newRequest` and returns the request the guard passes back to the
    /// URL loading system (what it intends for the next hop). The guard invokes the
    /// completion handler synchronously.
    private func redirectOutcome(
        guardHeaders: [CustomHeader],
        destination: String,
        requestHeaders: [String: String]
    ) throws -> URLRequest {
        let stripper = CrossOriginHeaderStripper(baseURL: baseURL, customHeaderProvider: { guardHeaders })
        var newRequest = URLRequest(url: try XCTUnwrap(URL(string: destination)))
        for (name, value) in requestHeaders {
            newRequest.setValue(value, forHTTPHeaderField: name)
        }
        let response = try XCTUnwrap(
            HTTPURLResponse(url: newRequest.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: nil)
        )
        let dummy = URLSession(configuration: .ephemeral)
        let task = dummy.dataTask(with: try XCTUnwrap(URL(string: "https://example.test")))
        var result: URLRequest?
        stripper.urlSession(dummy, task: task, willPerformHTTPRedirection: response, newRequest: newRequest) {
            result = $0
        }
        return try XCTUnwrap(result, "guard did not call the completion handler")
    }

    // AC1: same-origin → cross-origin carries none of the custom headers.
    func testStripsCustomHeadersOnCrossOriginRedirect() throws {
        let outgoing = try redirectOutcome(
            guardHeaders: [
                CustomHeader(name: "Authorization", value: "Bearer secret"),
                CustomHeader(name: "X-Api-Key", value: "k1")
            ],
            destination: "https://third-party.example/leak",
            requestHeaders: ["Authorization": "Bearer secret", "X-Api-Key": "k1", "Accept": "*/*"]
        )

        XCTAssertNil(outgoing.value(forHTTPHeaderField: "X-Api-Key"))
        XCTAssertNil(outgoing.value(forHTTPHeaderField: "Authorization"))
        // Only the *configured* header names are stripped — a built-in like Accept
        // is left alone.
        XCTAssertEqual(outgoing.value(forHTTPHeaderField: "Accept"), "*/*")
    }

    // AC2: same-origin → same-origin keeps the headers (e.g. a proxy path rewrite).
    func testKeepsCustomHeadersOnSameOriginRedirect() throws {
        let outgoing = try redirectOutcome(
            guardHeaders: [CustomHeader(name: "X-Api-Key", value: "k1")],
            destination: "https://example.test/api/media-final",
            requestHeaders: ["X-Api-Key": "k1"]
        )

        XCTAssertEqual(outgoing.value(forHTTPHeaderField: "X-Api-Key"), "k1")
    }

    // AC3: no custom headers configured → a cross-origin redirect is left unchanged.
    func testNoCustomHeadersLeavesCrossOriginRedirectUnchanged() throws {
        let outgoing = try redirectOutcome(
            guardHeaders: [],
            destination: "https://third-party.example/leak",
            requestHeaders: ["Accept": "*/*"]
        )

        XCTAssertEqual(outgoing.value(forHTTPHeaderField: "Accept"), "*/*")
        XCTAssertNil(outgoing.value(forHTTPHeaderField: "X-Api-Key"))
    }

    // AC4: end-to-end via a redirect-emitting URLProtocol — the production guard,
    // wired into the client's session, strips the custom header so the actual
    // second hop on the wire (cross-origin) never carries it. Exercises the real
    // `downloadData` path: the header is applied on the same-origin first hop and
    // removed when the server redirects off-origin.
    func testStripsCustomHeaderEndToEndOnURLProtocolRedirect() async throws {
        RedirectingMockURLProtocol.redirect = .init(
            fromPath: "/api/media",
            to: try XCTUnwrap(URL(string: "https://third-party.example/leak"))
        )
        let client = APIClient(baseURL: baseURL, customHeaderProvider: {
            [CustomHeader(name: "X-Api-Key", value: "k1")]
        })
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedirectingMockURLProtocol.self]
        let session = URLSession(
            configuration: configuration,
            delegate: client.redirectHeaderStripper,
            delegateQueue: nil
        )

        _ = try? await client.downloadData(
            from: try XCTUnwrap(URL(string: "https://example.test/api/media?path=/x.png")),
            using: session,
            mapsUnauthorized: false
        )

        let secondHop = try XCTUnwrap(RedirectingMockURLProtocol.secondHopRequest)
        XCTAssertEqual(secondHop.url?.host, "third-party.example")
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "X-Api-Key"))
    }
}
