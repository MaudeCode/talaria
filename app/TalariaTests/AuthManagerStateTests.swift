import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
final class AuthManagerStateTests: XCTestCase {
    private struct PreconditionFailure: Error {}

    private let cookieStorage = URLSessionConfiguration.ephemeral.httpCookieStorage!
    private let profileEntityCache = ProfileEntityCache(defaults: nil)

    private func recoveryManager(
        status: AuthStatusResponse = AuthStatusResponse(authEnabled: true, loggedIn: false),
        password: String? = nil,
        oidcProfile: String? = nil
    ) throws -> (AuthManager, MockAuthAPIClient, URL) {
        let server = URL(string: "https://recovery.test")!
        let keychain = InMemoryKeychainStore()
        try keychain.save(server.absoluteString, forKey: .serverURL)
        if let password { try keychain.save(password, forKey: .serverPassword, scope: server.absoluteString) }
        if let oidcProfile { try keychain.save(oidcProfile, forKey: .authenticatedProfile, scope: server.absoluteString) }
        let client = MockAuthAPIClient(authStatus: status)
        let manager = AuthManager(
            keychain: keychain, clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client }, headerStore: CustomHeaderStore(),
            cookieStorage: cookieStorage, profileEntityCache: profileEntityCache,
            serverRegistry: ServerRegistry.inMemory()
        )
        return (manager, client, server)
    }

    func testConfirmedSessionLossPreservesStateAndCookies() async throws {
        let (manager, client, server) = try recoveryManager()
        cookieStorage.setCookie(try makeSessionCookie(for: server))
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertEqual(cookieStorage.cookies(for: server)?.map(\.value), ["stale-session-token"])
        XCTAssertEqual(client.authStatusCallCount, 1)
        XCTAssertTrue(manager.reauthenticationOffersPassword)
        XCTAssertFalse(manager.reauthenticationOffersSSO)
    }

    func testIntactSessionKeepsCookiesWithoutPromptOrRetry() async throws {
        let (manager, client, server) = try recoveryManager(status: AuthStatusResponse(loggedIn: true), password: "secret")
        cookieStorage.setCookie(try makeSessionCookie(for: server))
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(cookieStorage.cookies(for: server)?.count, 1)
        XCTAssertTrue(client.loginPasswords.isEmpty)
    }

    func testTenConcurrentUnauthorizedErrorsCoalesceIntoOneProbe() async throws {
        let (manager, client, server) = try recoveryManager()
        client.authStatusDelay = .milliseconds(30)
        for _ in 0..<10 { manager.handleAPIError(APIError.unauthorized) }
        await manager.recoveryTask?.value
        manager.handleAPIError(APIError.unauthorized)
        XCTAssertEqual(client.authStatusCallCount, 1)
        XCTAssertEqual(manager.pendingReauthentication, server)
    }

    func testProbeUnauthorizedConfirmsLossButNetworkFailureDoesNot() async throws {
        let (manager, client, server) = try recoveryManager()
        client.authStatusError = URLError(.notConnectedToInternet)
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertNil(manager.pendingReauthentication)
        client.authStatusError = APIError.unauthorized
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.pendingReauthentication, server)
    }

    func testUnauthorizedProbeOffersHeaderRepairBeforeRediscoveringSignInMethods() async throws {
        for usesSSO in [false, true] {
            let (manager, client, server) = try recoveryManager(oidcProfile: usesSSO ? "fixture-profile" : nil)
            client.authStatusError = APIError.unauthorized
            manager.handleAPIError(APIError.unauthorized)
            await manager.recoveryTask?.value
            XCTAssertEqual(manager.pendingReauthentication, server)
            XCTAssertFalse(manager.reauthenticationOffersSSO)
            XCTAssertFalse(manager.reauthenticationOffersPassword)

            client.authStatusError = nil
            client.authStatusResponse = AuthStatusResponse(
                authEnabled: true, loggedIn: false, passwordAuthEnabled: !usesSSO,
                oidcEnabled: usesSSO, oidcNativeHandoffEnabled: usesSSO
            )
            await manager.configure(
                serverURLString: server.absoluteString, password: "",
                customHeaders: [CustomHeader(name: "X-Fixture", value: "repaired")]
            )
            XCTAssertEqual(manager.pendingReauthentication, server)
            XCTAssertEqual(manager.reauthenticationOffersSSO, usesSSO)
            XCTAssertEqual(manager.reauthenticationOffersPassword, !usesSSO)
            if usesSSO { XCTAssertNil(manager.lastErrorMessage) }
        }
    }

    func testRecoverySignInMethodsFollowCapabilitiesAndOIDCMarker() async throws {
        for (status, marker, sso, password) in [
            (AuthStatusResponse(loggedIn: false), "fixture-profile", true, false),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: false, oidcEnabled: false), "fixture-profile", false, false),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: false, oidcEnabled: true, oidcNativeHandoffEnabled: false), "fixture-profile", false, false),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: false, oidcEnabled: true), "fixture-profile", false, false),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: true, oidcEnabled: false), "fixture-profile", false, true),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: false, oidcNativeHandoffEnabled: true), nil, true, false),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: true, oidcNativeHandoffEnabled: true), nil, true, true),
            (AuthStatusResponse(loggedIn: false, passwordAuthEnabled: true), nil, false, true)
        ] {
            let (manager, _, _) = try recoveryManager(status: status, oidcProfile: marker)
            manager.handleAPIError(APIError.unauthorized)
            await manager.recoveryTask?.value
            XCTAssertEqual(manager.reauthenticationOffersSSO, sso)
            XCTAssertEqual(manager.reauthenticationOffersPassword, password)
        }
    }

    func testRetainedPasswordRetriesBeforePromptAndOnlyOnce() async throws {
        let (manager, client, server) = try recoveryManager(password: "secret")
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(client.loginPasswords, ["secret"])
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertEqual(client.loginPasswords, ["secret"])
    }

    func testFailedRetainedPasswordShowsPromptAndManualRetryDismissesIt() async throws {
        let (manager, client, server) = try recoveryManager(password: "stale")
        client.loginResponse = LoginResponse(ok: false, message: nil, error: nil)
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertEqual(client.loginPasswords, ["stale"])
        client.loginResponse = LoginResponse(ok: true, message: nil, error: nil)
        await manager.configure(serverURLString: server.absoluteString, password: "fresh")
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(manager.state, .loggedIn(server: server))
    }

    func testSwitchServerIgnoresPendingProbeAndOldServerErrors() async throws {
        let (manager, client, server) = try recoveryManager()
        client.authStatusDelay = .milliseconds(30)
        _ = await manager.addServer(serverURLString: "https://second.test", password: "secret")
        let original = try XCTUnwrap(manager.servers.first { $0.id == server.absoluteString })
        let second = try XCTUnwrap(manager.servers.first { $0.id != server.absoluteString })
        manager.switchActiveServer(to: original)
        let probeCount = client.authStatusCallCount
        manager.handleAPIError(APIError.unauthorized, server: server)
        let recovery = manager.recoveryTask
        manager.switchActiveServer(to: second)
        await recovery?.value
        manager.handleAPIError(APIError.unauthorized, server: server)
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertNil(manager.recoveryTask)
        XCTAssertEqual(manager.activeServerID, second.id)
        XCTAssertEqual(client.authStatusCallCount, probeCount)
    }

    func testSignOutAndAddingAnotherServerDismissRecovery() async throws {
        let (manager, _, server) = try recoveryManager()
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.pendingReauthentication, server)
        _ = await manager.addServer(serverURLString: "https://second.test", password: "secret")
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(manager.activeServerID, "https://second.test")
        manager.switchActiveServer(to: try XCTUnwrap(manager.servers.first { $0.id == server.absoluteString }))
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        await manager.signOut()
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(manager.activeServerID, "https://second.test")
        await manager.signOut()
        XCTAssertEqual(manager.state, .unconfigured)
    }

    func testRecoveryProbeCapturesOriginalHeadersAndCookieJar() async throws {
        let server = URL(string: "https://probe.test")!
        let keychain = InMemoryKeychainStore()
        try keychain.save(server.absoluteString, forKey: .serverURL)
        let headers = [CustomHeader(name: "X-Fixture", value: "original")]
        try keychain.save(try XCTUnwrap(headers.encodedForStorage()), forKey: .customHeaders, scope: server.absoluteString)
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(loggedIn: false))
        var capturedHeaders: [CustomHeader] = []
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in XCTFail("Recovery must use the explicit-header probe"); return client },
            probeClientFactory: { url, snapshot, cookies in
                XCTAssertEqual(url, server)
                XCTAssertTrue(cookies === self.cookieStorage)
                capturedHeaders = snapshot
                return client
            },
            headerStore: CustomHeaderStore(), cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache, serverRegistry: ServerRegistry.inMemory()
        )
        manager.handleAPIError(APIError.unauthorized)
        manager.updateCustomHeaders([CustomHeader(name: "X-Fixture", value: "changed")], persist: false)
        await manager.recoveryTask?.value
        XCTAssertEqual(capturedHeaders, headers)
        XCTAssertEqual(client.authStatusCallCount, 1)
        XCTAssertEqual(manager.pendingReauthentication, server)
    }

    func testTrustedHeaderRecoveryKeepsGuidanceAndAcceptsCorrectedHeaders() async throws {
        let (manager, client, server) = try recoveryManager(status: AuthStatusResponse(
            authEnabled: true, loggedIn: false, passwordAuthEnabled: false, trustedAuthEnabled: true
        ))
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertFalse(manager.reauthenticationOffersSSO)
        XCTAssertFalse(manager.reauthenticationOffersPassword)
        XCTAssertEqual(manager.lastErrorMessage, AuthManager.trustedAuthNotSignedInMessage)
        client.authStatusResponse = AuthStatusResponse(
            authEnabled: true, loggedIn: true, passwordAuthEnabled: false, trustedAuthEnabled: true
        )
        let headers = [CustomHeader(name: "X-Fixture-Authorization", value: "fixture-token")]
        await manager.configure(serverURLString: server.absoluteString, password: "", customHeaders: headers)
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertEqual(manager.currentCustomHeaders, headers)
        XCTAssertTrue(client.loginPasswords.isEmpty)
    }

    func testNonUnauthorizedErrorDoesNotChangeState() async throws {
        let keychain = InMemoryKeychainStore()
        let manager = try await makeLoggedInManager(keychain: keychain, serverURLString: "https://example.test")
        let server = try XCTUnwrap(URL(string: "https://example.test"))

        manager.handleAPIError(APIError.http(statusCode: 502, body: ""))

        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertEqual(keychain.savedValues[.serverURL], server.absoluteString)
    }

    func testSignOutFullyClearsServerAndReturnsToUnconfigured() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = try await makeLoggedInManager(
            keychain: keychain,
            serverURLString: "https://example.test",
            client: client
        )

        await manager.signOut()

        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNil(keychain.savedValues[.serverURL])
        // Server-side logout is still attempted best-effort when reachable.
        XCTAssertEqual(client.logoutCallCount, 1)
    }

    func testSignOutClearsLocalAuthWhenServerLogoutFails() async throws {
        let keychain = InMemoryKeychainStore()
        // Server unreachable: the best-effort logout throws, but local sign-out
        // must still succeed so the user can reach onboarding (issue #249).
        let client = MockAuthAPIClient(
            authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false),
            logoutBehavior: .fail(APIError.network(underlying: URLError(.notConnectedToInternet)))
        )
        let manager = try await makeLoggedInManager(
            keychain: keychain,
            serverURLString: "https://example.test",
            client: client
        )

        await manager.signOut()

        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(client.logoutCallCount, 1)
    }

    func testSignOutCompletesWhenServerLogoutHangs() async throws {
        let keychain = InMemoryKeychainStore()
        // Server accepts the connection but never responds: sign-out must still
        // finish once the bounded logout times out, not hang indefinitely.
        let client = MockAuthAPIClient(
            authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false),
            logoutBehavior: .hang
        )
        let manager = try await makeLoggedInManager(
            keychain: keychain,
            serverURLString: "https://example.test",
            client: client,
            logoutTimeout: .milliseconds(50)
        )

        await manager.signOut()

        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(client.logoutCallCount, 1)
    }

    func testSignOutClearsSessionCookies() async throws {
        let keychain = InMemoryKeychainStore()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = try await makeLoggedInManager(
            keychain: keychain,
            serverURLString: "https://example.test",
            client: client
        )
        cookieStorage.setCookie(try makeSessionCookie(for: server))

        await manager.signOut()

        XCTAssertEqual(cookieStorage.cookies?.isEmpty, true)
        XCTAssertEqual(manager.state, .unconfigured)
    }

    // MARK: - Per-server isolation (#16)

    func testSignOutClearsOnlyActiveServerCookies() async throws {
        let keychain = InMemoryKeychainStore()
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))
        let manager = try await makeLoggedInManager(keychain: keychain, serverURLString: "https://a.test")
        // Both servers hold a session cookie in the manager's jar.
        cookieStorage.setCookie(try makeSessionCookie(for: serverA, value: "a-cookie"))
        cookieStorage.setCookie(try makeSessionCookie(for: serverB, value: "b-cookie"))

        await manager.signOut()

        // A's cookie is cleared; B (a different host) is untouched.
        XCTAssertTrue(cookieStorage.cookies(for: serverA)?.isEmpty ?? true)
        XCTAssertEqual(cookieStorage.cookies(for: serverB)?.map(\.value), ["b-cookie"])
    }

    func testUnauthorizedPreservesBothServersCookies() async throws {
        let keychain = InMemoryKeychainStore()
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))
        let manager = try await makeLoggedInManager(keychain: keychain, serverURLString: "https://a.test")
        cookieStorage.setCookie(try makeSessionCookie(for: serverA, value: "a-cookie"))
        cookieStorage.setCookie(try makeSessionCookie(for: serverB, value: "b-cookie"))

        try keychain.delete(.serverPassword, scope: serverA.absoluteString)
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value

        // Only the active server's auth is affected by its 401.
        XCTAssertEqual(manager.state, .loggedIn(server: serverA))
        XCTAssertEqual(manager.pendingReauthentication, serverA)
        XCTAssertEqual(cookieStorage.cookies(for: serverA)?.map(\.value), ["a-cookie"])
        XCTAssertEqual(cookieStorage.cookies(for: serverB)?.map(\.value), ["b-cookie"])
    }

    func testSignOutLeavesOtherServerHeadersAndRegistryIntact() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory()
        // Pre-seed server B: a registry entry plus its scoped custom headers.
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))
        try registry.activate(url: serverB)
        let bHeaders = try XCTUnwrap([CustomHeader(name: "X-B", value: "b-token")].encodedForStorage())
        try keychain.save(bHeaders, forKey: .customHeaders, scope: "https://b.test")

        // Sign in to server A as the active server, with its own scoped headers.
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            headerStore: CustomHeaderStore(),
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            serverRegistry: registry
        )
        await manager.configure(
            serverURLString: "https://a.test",
            password: "",
            customHeaders: [CustomHeader(name: "X-A", value: "a-token")]
        )
        XCTAssertNotNil(keychain.scopedValue(.customHeaders, scope: "https://a.test"))

        await manager.signOut()

        // A's scoped headers + registry entry are gone; B's are untouched.
        XCTAssertNil(keychain.scopedValue(.customHeaders, scope: "https://a.test"))
        XCTAssertNotNil(keychain.scopedValue(.customHeaders, scope: "https://b.test"))
        XCTAssertEqual(registry.servers.map(\.id), ["https://b.test"])
    }

    // MARK: - Multi-server switch / remove / identity (#17)

    func testSwitchActiveServerMakesItActiveAndOptimisticallyLoggedIn() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, bAccount) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))

        manager.switchActiveServer(to: bAccount)

        XCTAssertEqual(manager.state, .loggedIn(server: serverB))
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://b.test")
        XCTAssertEqual(registry.activeServerID, "https://b.test")
        XCTAssertEqual(manager.activeServerID, "https://b.test")
    }

    func testSwitchToTheAlreadyActiveServerIsANoOp() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, aAccount, _) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))

        manager.switchActiveServer(to: aAccount)

        XCTAssertEqual(manager.state, .loggedIn(server: serverA))
        XCTAssertEqual(registry.activeServerID, "https://a.test")
    }

    func testSwitchUsesRegistryWhenLegacyURLMirrorFails() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, bAccount) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        keychain.saveErrors[.serverURL] = PreconditionFailure()

        manager.switchActiveServer(to: bAccount)

        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://b.test"))))
        XCTAssertEqual(registry.activeServerID, "https://b.test")
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://a.test")

        let restored = AuthManager(
            keychain: keychain,
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            serverRegistry: registry
        )
        XCTAssertEqual(restored.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://b.test"))))
    }

    func testRemoveActiveServerAutoSwitchesToRemaining() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, aAccount, _) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))

        await manager.removeServer(aAccount)

        XCTAssertEqual(manager.state, .loggedIn(server: serverB))
        XCTAssertEqual(registry.servers.map(\.id), ["https://b.test"])
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://b.test")
    }

    func testRemoveLastServerReturnsToOnboarding() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            serverRegistry: registry
        )
        await manager.configure(serverURLString: "https://a.test", password: "")
        let aAccount = try XCTUnwrap(registry.servers.first { $0.id == "https://a.test" })

        await manager.removeServer(aAccount)

        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertTrue(registry.servers.isEmpty)
        XCTAssertNil(keychain.savedValues[.serverURL])
    }

    func testRemoveNonActiveServerLeavesActiveLoggedIn() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, bAccount) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))

        await manager.removeServer(bAccount)

        XCTAssertEqual(manager.state, .loggedIn(server: serverA))
        XCTAssertEqual(registry.servers.map(\.id), ["https://a.test"])
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://a.test")
    }

    func testRemoveNonActiveServerClearsOnlyItsCookies() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, bAccount) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))
        cookieStorage.setCookie(try makeSessionCookie(for: serverA, value: "a-cookie"))
        cookieStorage.setCookie(try makeSessionCookie(for: serverB, value: "b-cookie"))

        await manager.removeServer(bAccount)

        XCTAssertEqual(cookieStorage.cookies(for: serverA)?.map(\.value), ["a-cookie"])
        XCTAssertTrue(cookieStorage.cookies(for: serverB)?.isEmpty ?? true)
    }

    func testRemoveFailureReturnsFalseAndKeepsServerState() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        var resets: [URL] = []
        let (manager, _, bAccount) = try await makeTwoServerManager(
            keychain: keychain,
            registry: registry,
            resetServerScopedState: { resets.append($0) }
        )
        keychain.saveErrors[.servers] = PreconditionFailure()

        let removed = await manager.removeServer(bAccount)

        XCTAssertFalse(removed)
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://a.test"))))
        XCTAssertEqual(registry.servers.map(\.id), ["https://b.test", "https://a.test"])
        XCTAssertNotNil(manager.lastErrorMessage)
        // A server that is still configured keeps its local state (TAL-146).
        XCTAssertTrue(resets.isEmpty)
    }

    // MARK: - Server-scoped purge on sign-out / removal (TAL-146)

    func testSignOutPurgesTheRemovedServerOnceAfterRegistryRemoval() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        var resets: [(server: URL, registeredIDs: [String])] = []
        let (manager, _, _) = try await makeTwoServerManager(
            keychain: keychain,
            registry: registry,
            resetServerScopedState: { resets.append(($0, registry.servers.map(\.id))) }
        )
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))

        await manager.signOut()

        XCTAssertEqual(resets.map(\.server), [serverA])
        // The purge runs only once the registry no longer contains the server.
        XCTAssertEqual(resets.first?.registeredIDs, ["https://b.test"])
        XCTAssertEqual(manager.state, .loggedIn(server: serverB))
    }

    func testRemoveNonActiveServerPurgesOnlyThatServer() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        var resets: [(server: URL, registeredIDs: [String])] = []
        let (manager, _, bAccount) = try await makeTwoServerManager(
            keychain: keychain,
            registry: registry,
            resetServerScopedState: { resets.append(($0, registry.servers.map(\.id))) }
        )
        let serverA = try XCTUnwrap(URL(string: "https://a.test"))
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))

        await manager.removeServer(bAccount)

        XCTAssertEqual(resets.map(\.server), [serverB])
        XCTAssertEqual(resets.first?.registeredIDs, ["https://a.test"])
        XCTAssertEqual(manager.state, .loggedIn(server: serverA))
    }

    func testPurgeFailureOnSignOutDoesNotUndoTheRemoval() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, _) = try await makeTwoServerManager(
            keychain: keychain,
            registry: registry,
            resetServerScopedState: { _ in throw PreconditionFailure() }
        )

        await manager.signOut()

        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://b.test"))))
        XCTAssertEqual(registry.servers.map(\.id), ["https://b.test"])
        XCTAssertNil(manager.lastErrorMessage)
    }

    func testSignOutWithRemainingServerAutoSwitches() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, _) = try await makeTwoServerManager(keychain: keychain, registry: registry)
        let serverB = try XCTUnwrap(URL(string: "https://b.test"))

        await manager.signOut()

        XCTAssertEqual(manager.state, .loggedIn(server: serverB))
        XCTAssertEqual(registry.servers.map(\.id), ["https://b.test"])
    }

    func testConfiguringASecondServerAddsItAndMakesItActive() async throws {
        let widgetDefaults = try XCTUnwrap(
            UserDefaults(suiteName: ProviderQuotaWidgetSnapshotStore.appGroupIdentifier)
        )
        defer { widgetDefaults.removeObject(forKey: ProviderQuotaWidgetSnapshotStore.storageKey) }
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            serverRegistry: registry
        )

        await manager.configure(serverURLString: "https://a.test", password: "")
        widgetDefaults.set(Data([1]), forKey: ProviderQuotaWidgetSnapshotStore.storageKey)
        await manager.configure(serverURLString: "https://b.test", password: "")

        XCTAssertEqual(Set(manager.servers.map(\.id)), ["https://a.test", "https://b.test"])
        XCTAssertEqual(manager.activeServerID, "https://b.test")
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://b.test"))))
        XCTAssertNil(widgetDefaults.object(forKey: ProviderQuotaWidgetSnapshotStore.storageKey))
    }

    func testAddServerNeedsPasswordWhenAuthEnabledAndNoPassword() async {
        let manager = AuthManager(
            keychain: InMemoryKeychainStore(),
            probeClientFactory: { _, _, _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false)) },
            cookieStorage: cookieStorage,
            serverRegistry: ServerRegistry.inMemory()
        )

        let outcome = await manager.addServer(serverURLString: "https://needs-pw.test", password: "")

        XCTAssertEqual(outcome, .needsPassword)
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertTrue(manager.servers.isEmpty)
    }

    func testAddServerRejectsAnAlreadyConfiguredURL() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            serverRegistry: registry
        )
        await manager.configure(serverURLString: "https://a.test", password: "")

        let outcome = await manager.addServer(serverURLString: "https://a.test", password: "")

        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(manager.lastErrorMessage, "This server is already configured.")
        XCTAssertEqual(manager.servers.map(\.id), ["https://a.test"])
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://a.test"))))
    }

    func testAddServerSucceedsAndSwitchesActive() async throws {
        let widgetDefaults = try XCTUnwrap(
            UserDefaults(suiteName: ProviderQuotaWidgetSnapshotStore.appGroupIdentifier)
        )
        defer { widgetDefaults.removeObject(forKey: ProviderQuotaWidgetSnapshotStore.storageKey) }
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            probeClientFactory: { _, _, _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            serverRegistry: registry
        )
        await manager.configure(serverURLString: "https://a.test", password: "")
        widgetDefaults.set(Data([1]), forKey: ProviderQuotaWidgetSnapshotStore.storageKey)

        let outcome = await manager.addServer(serverURLString: "https://b.test", password: "")

        XCTAssertEqual(outcome, .added(try XCTUnwrap(URL(string: "https://b.test"))))
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://b.test"))))
        XCTAssertEqual(Set(manager.servers.map(\.id)), ["https://a.test", "https://b.test"])
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://b.test")
        XCTAssertNil(widgetDefaults.object(forKey: ProviderQuotaWidgetSnapshotStore.storageKey))
    }

    func testAddServerFailureKeepsActiveServerAndItsHeaders() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let clientA = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let clientB = MockAuthAPIClient(
            authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false),
            loginResponse: LoginResponse(ok: false, message: nil, error: "nope")
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { $0.absoluteString.contains("a.test") ? clientA : clientB },
            probeClientFactory: { url, _, _ in url.absoluteString.contains("a.test") ? clientA : clientB },
            headerStore: CustomHeaderStore(),
            cookieStorage: cookieStorage,
            serverRegistry: registry
        )
        await manager.configure(
            serverURLString: "https://a.test",
            password: "secret",
            customHeaders: [CustomHeader(name: "X-A", value: "a-token")]
        )
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://a.test"))))

        let outcome = await manager.addServer(
            serverURLString: "https://b.test",
            password: "wrong",
            customHeaders: [CustomHeader(name: "X-B", value: "b-token")]
        )

        XCTAssertEqual(outcome, .failed)
        // The active server, its state, registry, and live headers are untouched.
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://a.test"))))
        XCTAssertEqual(manager.servers.map(\.id), ["https://a.test"])
        XCTAssertEqual(manager.currentCustomHeaders.map(\.name), ["X-A"])
        XCTAssertEqual(manager.currentCustomHeaders.map(\.value), ["a-token"])
    }

    func testAddServerRegistryFailureKeepsSavedAndActiveServer() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            probeClientFactory: { _, _, _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            serverRegistry: registry
        )
        await manager.configure(serverURLString: "https://a.test", password: "")
        keychain.saveErrors[.servers] = PreconditionFailure()

        let outcome = await manager.addServer(serverURLString: "https://b.test", password: "")

        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://a.test")
        XCTAssertEqual(registry.activeServerID, "https://a.test")
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://a.test"))))
    }

    func testServersSnapshotMirrorsRegistry() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let (manager, _, _) = try await makeTwoServerManager(keychain: keychain, registry: registry)

        XCTAssertEqual(Set(manager.servers.map(\.id)), ["https://a.test", "https://b.test"])
        XCTAssertEqual(manager.activeServerID, "https://a.test")
    }

    func testCustomHeadersAreLoadedForRequestedServerOnly() async throws {
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        let bHeaders = try XCTUnwrap([CustomHeader(name: "X-B", value: "b-token")].encodedForStorage())
        try keychain.save(bHeaders, forKey: .customHeaders, scope: "https://b.test")
        let (manager, aAccount, bAccount) = try await makeTwoServerManager(
            keychain: keychain,
            registry: registry
        )

        manager.updateCustomHeaders([CustomHeader(name: "X-A", value: "a-token")])

        XCTAssertEqual(manager.customHeaders(for: aAccount).map(\.value), ["a-token"])
        XCTAssertEqual(manager.customHeaders(for: bAccount).map(\.value), ["b-token"])
    }

    func testUpdateServerIdentityPersistsAndMirrorsTheActiveServer() async throws {
        let keychain = InMemoryKeychainStore()
        let defaults = UserDefaults.ephemeral()
        let registry = ServerRegistry(keychain: keychain, identityDefaults: defaults)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            serverRegistry: registry
        )
        await manager.configure(serverURLString: "https://a.test", password: "")
        let aAccount = try XCTUnwrap(registry.servers.first { $0.id == "https://a.test" })

        manager.updateServerIdentity(
            aAccount,
            displayName: "Work",
            initials: "WK",
            headerLogoColorHex: "#5B7CFF"
        )

        let updated = try XCTUnwrap(manager.servers.first { $0.id == "https://a.test" })
        XCTAssertEqual(updated.displayName, "Work")
        XCTAssertEqual(updated.initials, "WK")
        XCTAssertEqual(updated.headerLogoColorHex, "#5B7CFF")
        // The active server's identity is mirrored into the global defaults.
        XCTAssertEqual(defaults.string(forKey: SessionIdentitySettings.displayNameKey), "Work")
        XCTAssertEqual(defaults.string(forKey: HeaderLogoColor.storageKey), "#5B7CFF")
    }

    /// Builds a manager with two registered servers: `a.test` signed in + active,
    /// `b.test` present but inactive. Returns the manager and both accounts.
    private func makeTwoServerManager(
        keychain: InMemoryKeychainStore,
        registry: ServerRegistry,
        resetServerScopedState: @escaping @MainActor (URL) async throws -> Void = { _ in }
    ) async throws -> (AuthManager, ServerAccount, ServerAccount) {
        // Pre-seed B (becomes inactive once A signs in), then sign in to A.
        try registry.activate(url: try XCTUnwrap(URL(string: "https://b.test")))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            resetServerScopedState: resetServerScopedState,
            serverRegistry: registry
        )
        await manager.configure(serverURLString: "https://a.test", password: "")

        guard case .loggedIn = manager.state else {
            XCTFail("Expected loggedIn after configure, got \(manager.state)")
            throw PreconditionFailure()
        }

        let aAccount = try XCTUnwrap(registry.servers.first { $0.id == "https://a.test" })
        let bAccount = try XCTUnwrap(registry.servers.first { $0.id == "https://b.test" })
        return (manager, aAccount, bAccount)
    }

    private func makeLoggedInManager(
        keychain: InMemoryKeychainStore,
        serverURLString: String,
        client providedClient: MockAuthAPIClient? = nil,
        logoutTimeout: Duration = .seconds(5)
    ) async throws -> AuthManager {
        let client = providedClient
            ?? MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            cookieStorage: cookieStorage,
            profileEntityCache: profileEntityCache,
            logoutTimeout: logoutTimeout,
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configure(serverURLString: serverURLString, password: "secret")

        guard case .loggedIn = manager.state else {
            XCTFail("Expected loggedIn state after configure, got \(manager.state)")
            throw PreconditionFailure()
        }

        return manager
    }

    private func makeSessionCookie(for server: URL, value: String = "stale-session-token") throws -> HTTPCookie {
        try XCTUnwrap(
            HTTPCookie(properties: [
                .domain: try XCTUnwrap(server.host),
                .path: "/",
                .name: "hermes_session",
                .value: value,
            ])
        )
    }
}
