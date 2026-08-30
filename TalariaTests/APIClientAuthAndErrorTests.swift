import XCTest
import CryptoKit
@testable import Talaria

final class APIClientAuthAndErrorTests: APIClientTestCase {
    func testOnboardingPasswordValidationOnlyRequiresKnownAuthEnabledPassword() {
        XCTAssertEqual(
            OnboardingViewModel.passwordValidationMessage(
                authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false),
                password: " \n "
            ),
            OnboardingViewModel.emptyPasswordMessage
        )
        XCTAssertNil(
            OnboardingViewModel.passwordValidationMessage(
                authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false),
                password: "secret"
            )
        )
        XCTAssertNil(
            OnboardingViewModel.passwordValidationMessage(
                authStatus: AuthStatusResponse(authEnabled: false, loggedIn: false),
                password: ""
            )
        )
        XCTAssertNil(OnboardingViewModel.passwordValidationMessage(authStatus: nil, password: ""))
    }

    @MainActor
    func testAuthManagerConnectsToNoPasswordTailscaleServerWithoutLogin() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false, loggedIn: false))
        var requestedURLs: [URL] = []
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { url in
                requestedURLs.append(url)
                return client
            },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configure(serverURLString: "100.96.12.34:9119", password: "")

        let expectedURL = try XCTUnwrap(URL(string: "http://100.96.12.34:9119"))
        XCTAssertEqual(requestedURLs, [expectedURL])
        XCTAssertEqual(client.loginPasswords, [])
        XCTAssertEqual(keychain.savedValues[.serverURL], expectedURL.absoluteString)
        XCTAssertEqual(manager.state, .loggedIn(server: expectedURL))
        XCTAssertNil(manager.lastErrorMessage)
    }

    func testServerURLNormalizationDropsAccidentalWWWBeforeWebUISubdomain() throws {
        XCTAssertEqual(
            try AuthManager.normalizedServerURL(from: "https://www.webui.example.test"),
            URL(string: "https://webui.example.test")
        )
        XCTAssertEqual(
            try AuthManager.normalizedServerURL(from: "www.webui.example.test"),
            URL(string: "https://webui.example.test")
        )
        XCTAssertEqual(
            try AuthManager.normalizedServerURL(from: "https://www.example.com"),
            URL(string: "https://www.example.com")
        )
    }

    @MainActor
    func testAuthManagerPreservesPasswordRequiredEmptyPasswordBehavior() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configure(serverURLString: "https://example.test", password: "")

        XCTAssertEqual(client.loginPasswords, [])
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertEqual(manager.lastErrorMessage, OnboardingViewModel.emptyPasswordMessage)
    }

    @MainActor
    func testAuthManagerLogsInWhenPasswordIsRequired() async throws {
        let keychain = InMemoryKeychainStore()
        let client = MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configure(serverURLString: "https://example.test", password: "secret")

        let expectedURL = try XCTUnwrap(URL(string: "https://example.test"))
        XCTAssertEqual(client.loginPasswords, ["secret"])
        XCTAssertEqual(keychain.savedValues[.serverURL], expectedURL.absoluteString)
        XCTAssertEqual(manager.state, .loggedIn(server: expectedURL))
        XCTAssertNil(manager.lastErrorMessage)
    }

    func testUnauthorizedResponseThrowsUnauthorized() async {
        let client = makeClient { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 401,
                httpVersion: nil,
                headerFields: nil
            )
            return (try XCTUnwrap(response), Data())
        }

        do {
            _ = try await client.sessions()
            XCTFail("Expected unauthorized error")
        } catch APIError.unauthorized {
            // Expected path.
        } catch {
            XCTFail("Expected unauthorized error, got \(error)")
        }
    }

    func testVanishedSessionResponseUsesRecoveryMessage() async throws {
        let client = makeClient { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 404,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            let body = Data(#"{"error":"Session not found"}"#.utf8)
            return (try XCTUnwrap(response), body)
        }

        do {
            _ = try await client.session(id: "missing-session")
            XCTFail("Expected vanished-session HTTP error")
        } catch let APIError.http(statusCode, body) {
            XCTAssertEqual(statusCode, 404)
            XCTAssertEqual(body, #"{"error":"Session not found"}"#)
            XCTAssertEqual(
                APIError.http(statusCode: statusCode, body: body).localizedDescription,
                "That session no longer exists on the server. Reopen another session or create a new one."
            )
        } catch {
            XCTFail("Expected vanished-session HTTP error, got \(error)")
        }
    }

    func testCloudflareErrorDoesNotExposeRawHTMLBody() async throws {
        let client = makeClient { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 502,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/html"]
            )
            let body = Data("<html><title>Bad gateway</title><body>cloudflare</body></html>".utf8)
            return (try XCTUnwrap(response), body)
        }

        do {
            _ = try await client.sessions()
            XCTFail("Expected HTTP error")
        } catch let APIError.http(statusCode, body) {
            let message = APIError.http(statusCode: statusCode, body: body).localizedDescription
            XCTAssertEqual(
                message,
                "The server or Cloudflare tunnel is unavailable. Check that the Mac is awake, hermes-webui is running, and the tunnel is connected."
            )
            XCTAssertFalse(message.contains("<html>"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("bad gateway"))
        } catch {
            XCTFail("Expected HTTP error, got \(error)")
        }
    }

    func testHTTPErrorPrivacySafeLogCategoryDoesNotExposeServerBody() {
        let error = APIError.http(
            statusCode: 400,
            body: #"{"error":"password=secret prompt=private raw response"}"#
        )

        let category = error.privacySafeLogCategory

        XCTAssertEqual(category, "http.400")
        XCTAssertFalse(category.contains("secret"))
        XCTAssertFalse(category.contains("private"))
        XCTAssertFalse(category.contains("raw response"))
    }

    func testNetworkErrorPrivacySafeLogCategoryUsesOnlyURLCode() {
        let error = APIError.network(underlying: URLError(.timedOut))

        XCTAssertEqual(error.privacySafeLogCategory, "network.url.-1001")
    }

    func testNetworkTimeoutUsesSetupGuidance() async throws {
        let error = APIError.network(underlying: URLError(.timedOut))

        XCTAssertEqual(
            error.localizedDescription,
            "The server did not respond in time. Check that the Mac is awake, hermes-webui is running, and the tunnel is connected."
        )
    }

    func testAppTransportSecurityErrorUsesHTTPGuidance() async throws {
        let error = APIError.network(underlying: URLError(.appTransportSecurityRequiresSecureConnection))

        XCTAssertEqual(
            error.localizedDescription,
            "iOS blocked this insecure HTTP connection. Use HTTPS, or use a Tailscale IP in the 100.64.0.0/10 range."
        )
    }

    func testOIDCCapabilityRequiresNativeHandoffForPasswordlessServer() {
        let compatible = AuthStatusResponse(
            authEnabled: true,
            loggedIn: false,
            passwordAuthEnabled: false,
            oidcEnabled: true,
            oidcNativeHandoffEnabled: true
        )
        let browserOnly = AuthStatusResponse(
            authEnabled: true,
            loggedIn: false,
            passwordAuthEnabled: false,
            oidcEnabled: true
        )

        XCTAssertNil(AuthManager.unsupportedSignInMessage(for: compatible))
        XCTAssertEqual(
            AuthManager.unsupportedSignInMessage(for: browserOnly),
            AuthManager.oidcOnlyMessage
        )
        XCTAssertTrue(OnboardingViewModel.canSignInWithOIDC(status: compatible))
        XCTAssertFalse(OnboardingViewModel.canSignInWithOIDC(status: browserOnly))
    }

    func testNativeOIDCFlowCreatesS256PKCEAndValidatesExactCallback() throws {
        let template = try NativeOIDCFlow.make(callbackScheme: "talaria-branch")
        var flow = template
        let expectedChallenge = Data(SHA256.hash(data: Data(flow.codeVerifier.utf8)))
            .base64URLEncodedString()
        let callback = try XCTUnwrap(URL(
            string: "talaria-branch://oidc-callback?code=one-time-code&state=\(flow.state)&flow_id=flow-1&server_id=server-1"
        ))

        XCTAssertEqual(flow.codeChallenge, expectedChallenge)
        XCTAssertEqual(
            try flow.exchangeCode(
                from: callback,
                expectedFlowID: "flow-1",
                expectedServerID: "server-1",
                expiresAt: Date().addingTimeInterval(60)
            ),
            "one-time-code"
        )

        for invalid in [
            "other://oidc-callback?code=c&state=\(flow.state)&flow_id=flow-1&server_id=server-1",
            "talaria-branch://wrong?code=c&state=\(flow.state)&flow_id=flow-1&server_id=server-1",
            "talaria-branch://oidc-callback?code=c&state=wrong&flow_id=flow-1&server_id=server-1",
            "talaria-branch://oidc-callback?code=c&state=\(flow.state)&flow_id=flow-2&server_id=server-1",
            "talaria-branch://oidc-callback?code=c&state=\(flow.state)&flow_id=flow-1&server_id=server-2",
            "talaria-branch://oidc-callback?code=c&state=\(flow.state)&flow_id=flow-1&server_id=server-1&token=must-not-appear"
        ] {
            var invalidFlow = template
            XCTAssertThrowsError(
                try invalidFlow.exchangeCode(
                    from: XCTUnwrap(URL(string: invalid)),
                    expectedFlowID: "flow-1",
                    expectedServerID: "server-1",
                    expiresAt: Date().addingTimeInterval(60)
                )
            )
        }

        XCTAssertThrowsError(
            try flow.exchangeCode(
                from: callback,
                expectedFlowID: "flow-1",
                expectedServerID: "server-1",
                expiresAt: Date().addingTimeInterval(60)
            )
        ) { error in
            XCTAssertEqual(error as? OIDCSignInError, .replayed)
        }

        var expiredFlow = template
        XCTAssertThrowsError(
            try expiredFlow.exchangeCode(
                from: callback,
                expectedFlowID: "flow-1",
                expectedServerID: "server-1",
                expiresAt: Date(timeIntervalSince1970: 1),
                now: Date(timeIntervalSince1970: 2)
            )
        ) { error in
            XCTAssertEqual(error as? OIDCSignInError, .expired)
        }
    }

    @MainActor
    func testAuthManagerCompletesNativeOIDCWithoutSavingBeforeExchange() async throws {
        let keychain = InMemoryKeychainStore()
        let client = OIDCMockAuthAPIClient()
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                XCTAssertNil(keychain.savedValues[.serverURL])
                return try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configureWithOIDC(serverURLString: "https://example.test")

        XCTAssertEqual(client.exchangeCodes, ["exchange-code"])
        let verifier = try XCTUnwrap(client.exchangeVerifiers.first)
        XCTAssertEqual(
            Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString(),
            client.codeChallenge
        )
        XCTAssertEqual(client.cancelledFlowIDs, [])
        XCTAssertEqual(keychain.savedValues[.serverURL], "https://example.test")
        XCTAssertEqual(manager.state, .loggedIn(server: try XCTUnwrap(URL(string: "https://example.test"))))
        XCTAssertNil(manager.lastErrorMessage)
    }

    @MainActor
    func testNativeOIDCCancellationLeavesNoSavedServerAndInvalidatesFlow() async throws {
        let keychain = InMemoryKeychainStore()
        let client = OIDCMockAuthAPIClient()
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, _ in throw OIDCSignInError.cancelled },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configureWithOIDC(serverURLString: "https://example.test")

        XCTAssertEqual(client.cancelledFlowIDs, ["flow-1"])
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertEqual(manager.lastErrorMessage, OIDCSignInError.cancelled.localizedDescription)
    }

    @MainActor
    func testNativeOIDCRejectsCrossServerAuthorizationURLAndCancelsFlow() async throws {
        let keychain = InMemoryKeychainStore()
        let client = OIDCMockAuthAPIClient(
            authorizationBaseURL: try XCTUnwrap(URL(string: "https://other.test"))
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, _ in
                XCTFail("A cross-server authorization URL must never open")
                throw OIDCSignInError.invalidAuthorizationURL
            },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configureWithOIDC(serverURLString: "https://example.test")

        XCTAssertEqual(client.cancelledFlowIDs, ["flow-1"])
        XCTAssertEqual(client.exchangeCodes, [])
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertEqual(
            manager.lastErrorMessage,
            OIDCSignInError.invalidAuthorizationURL.localizedDescription
        )
    }

    @MainActor
    func testNativeOIDCRejectsProviderErrorAndWrongCallbackWithoutExchange() async throws {
        for callbackQuery in [
            "error=provider_error&state={state}&flow_id=flow-1&server_id=server-1",
            "code=exchange-code&state=wrong&flow_id=flow-1&server_id=server-1"
        ] {
            let keychain = InMemoryKeychainStore()
            let client = OIDCMockAuthAPIClient()
            let manager = AuthManager(
                keychain: keychain,
                clientFactory: { _ in client },
                webAuthenticator: { _, scheme in
                    let query = callbackQuery.replacingOccurrences(
                        of: "{state}",
                        with: try XCTUnwrap(client.state)
                    )
                    return try XCTUnwrap(URL(string: "\(scheme)://oidc-callback?\(query)"))
                },
                serverRegistry: ServerRegistry.inMemory()
            )

            await manager.configureWithOIDC(serverURLString: "https://example.test")

            XCTAssertEqual(client.exchangeCodes, [])
            XCTAssertNil(keychain.savedValues[.serverURL])
            XCTAssertEqual(manager.state, .unconfigured)
            XCTAssertNotNil(manager.lastErrorMessage)
        }
    }

    @MainActor
    func testOIDCKeychainFailureClearsExchangedCookieAndLogsOut() async throws {
        let cookies = try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .name: "hermes_session",
            .value: "partial-session",
            .domain: "example.test",
            .path: "/",
            .secure: "TRUE"
        ]))
        var logoutSawCookie = false
        let client = OIDCMockAuthAPIClient(
            onExchange: { cookies.setCookie(cookie) },
            onLogout: { logoutSawCookie = cookies.cookies?.contains(cookie) == true }
        )
        let keychain = ServerURLFailingKeychain()
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStorage: cookies,
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configureWithOIDC(serverURLString: "https://example.test")

        XCTAssertTrue(cookies.cookies?.isEmpty ?? true)
        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertTrue(logoutSawCookie)
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNotNil(manager.lastErrorMessage)
    }

    @MainActor
    func testConcurrentOIDCStartIsRejectedWithoutMixingFlows() async throws {
        let client = OIDCMockAuthAPIClient()
        let browserStarted = expectation(description: "browser flow started")
        var browserContinuation: CheckedContinuation<URL, Error>?
        let manager = AuthManager(
            keychain: InMemoryKeychainStore(),
            clientFactory: { _ in client },
            webAuthenticator: { _, _ in
                try await withCheckedThrowingContinuation { continuation in
                    browserContinuation = continuation
                    browserStarted.fulfill()
                }
            },
            serverRegistry: ServerRegistry.inMemory()
        )

        let first = Task { @MainActor in
            await manager.configureWithOIDC(serverURLString: "https://example.test")
        }
        await fulfillment(of: [browserStarted], timeout: 2)

        await manager.configureWithOIDC(serverURLString: "https://example.test")
        XCTAssertEqual(client.beginCount, 1)
        XCTAssertEqual(
            manager.lastErrorMessage,
            OIDCSignInError.alreadyInProgress.localizedDescription
        )

        browserContinuation?.resume(returning: try XCTUnwrap(URL(
            string: "talaria://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
        )))
        await first.value

        XCTAssertEqual(client.beginCount, 1)
        XCTAssertEqual(client.exchangeCodes, ["exchange-code"])
        XCTAssertNil(manager.lastErrorMessage)
    }

    func testNativeOIDCExchangePersistsHttpOnlyCookieInClientSessionJar() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        let cookieStorage = try XCTUnwrap(configuration.httpCookieStorage)
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        let session = URLSession(configuration: configuration)
        let baseURL = try XCTUnwrap(URL(string: "https://example.test"))
        let client = APIClient(baseURL: baseURL, session: session, cookieStorage: cookieStorage)

        MockURLProtocol.requestHandler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
            let body = try apiTestJSONBody(from: request)
            switch request.url?.path {
            case "/api/auth/oidc/native/start":
                XCTAssertEqual(body["callback_url"] as? String, "talaria://oidc-callback")
                XCTAssertEqual(body["state"] as? String, "app-state")
                XCTAssertEqual(body["code_challenge"] as? String, "challenge")
                XCTAssertEqual(body["code_challenge_method"] as? String, "S256")
                return apiTestJSONResponse(
                    #"{"flow_id":"flow-1","authorization_url":"https://example.test/api/auth/oidc/start?native_flow=flow-1","server_id":"server-1","expires_in":600}"#,
                    for: request
                )
            case "/api/auth/oidc/native/exchange":
                XCTAssertEqual(body["flow_id"] as? String, "flow-1")
                XCTAssertEqual(body["code"] as? String, "one-time-code")
                XCTAssertEqual(body["state"] as? String, "app-state")
                XCTAssertEqual(body["code_verifier"] as? String, "verifier")
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: [
                        "Content-Type": "application/json",
                        "Set-Cookie": "hermes_session=session-value; Path=/; Secure; HttpOnly; SameSite=Lax"
                    ]
                ))
                return (response, Data(#"{"ok":true}"#.utf8))
            default:
                XCTFail("Unexpected OIDC request: \(request.url?.absoluteString ?? "nil")")
                throw URLError(.badURL)
            }
        }

        _ = try await client.beginNativeOIDC(
            callbackURL: try XCTUnwrap(URL(string: "talaria://oidc-callback")),
            state: "app-state",
            codeChallenge: "challenge"
        )
        _ = try await client.exchangeNativeOIDC(
            flowID: "flow-1",
            code: "one-time-code",
            state: "app-state",
            codeVerifier: "verifier"
        )

        XCTAssertEqual(cookieStorage.cookies?.map(\.name), ["hermes_session"])
        XCTAssertEqual(cookieStorage.cookies?.map(\.value), ["session-value"])
    }

    func testNativeOIDCExchangeFailsClosedWhenServerOmitsSessionCookie() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/auth/oidc/native/exchange")
            return apiTestJSONResponse(#"{"ok":true}"#, for: request)
        }

        do {
            _ = try await client.exchangeNativeOIDC(
                flowID: "flow-1",
                code: "one-time-code",
                state: "app-state",
                codeVerifier: "verifier"
            )
            XCTFail("An exchange without a session cookie must fail closed")
        } catch APIError.unauthorized {
            // Expected.
        } catch {
            XCTFail("Expected unauthorized, got \(error)")
        }
    }

    func testNativeOIDCExchangeRejectsNonHTTPOnlyCookie() async throws {
        let client = makeClient { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "Content-Type": "application/json",
                    "Set-Cookie": "not_a_session=value; Path=/; Secure"
                ]
            ))
            return (response, Data(#"{"ok":true}"#.utf8))
        }

        do {
            _ = try await client.exchangeNativeOIDC(
                flowID: "flow-1",
                code: "one-time-code",
                state: "app-state",
                codeVerifier: "verifier"
            )
            XCTFail("A non-HttpOnly cookie must not establish a session")
        } catch APIError.unauthorized {
            // Expected.
        } catch {
            XCTFail("Expected unauthorized, got \(error)")
        }
    }

    func testNativeOIDCExchangeRejectsInsecureOrInapplicableCookie() async throws {
        for cookie in [
            "hermes_session=value; Path=/; HttpOnly",
            "hermes_session=value; Path=/other; Secure; HttpOnly"
        ] {
            let client = makeClient { request in
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Set-Cookie": cookie]
                ))
                return (response, Data(#"{"ok":true}"#.utf8))
            }

            do {
                _ = try await client.exchangeNativeOIDC(
                    flowID: "flow-1",
                    code: "one-time-code",
                    state: "app-state",
                    codeVerifier: "verifier"
                )
                XCTFail("An insecure or inapplicable cookie must fail closed")
            } catch APIError.unauthorized {
                // Expected.
            } catch {
                XCTFail("Expected unauthorized, got \(error)")
            }
        }
    }

    @MainActor
    func testOIDCExchangeRejectsServerThatStillReportsLoggedOut() async throws {
        let keychain = InMemoryKeychainStore()
        let client = OIDCMockAuthAPIClient(reportsLoggedInAfterExchange: false)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            serverRegistry: ServerRegistry.inMemory()
        )

        await manager.configureWithOIDC(serverURLString: "https://example.test")

        XCTAssertEqual(client.exchangeCodes, ["exchange-code"])
        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertEqual(manager.lastErrorMessage, APIError.unauthorized.localizedDescription)
    }

    @MainActor
    func testAddServerOIDCKeepsActiveServerUntouchedUntilExchange() async throws {
        let activeURL = try XCTUnwrap(URL(string: "https://active.test"))
        let newURL = try XCTUnwrap(URL(string: "https://new.test"))
        let keychain = InMemoryKeychainStore()
        try keychain.save(activeURL.absoluteString, forKey: .serverURL)
        let registry = ServerRegistry.inMemory()
        registry.activate(url: activeURL)
        let client = OIDCMockAuthAPIClient(authorizationBaseURL: newURL)
        var manager: AuthManager!
        manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            webAuthenticator: { _, scheme in
                XCTAssertEqual(manager.state, .loggedIn(server: activeURL))
                XCTAssertEqual(keychain.savedValues[.serverURL], activeURL.absoluteString)
                return try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            serverRegistry: registry
        )

        let discovery = await manager.addServer(
            serverURLString: newURL.absoluteString,
            password: ""
        )
        XCTAssertEqual(discovery, .needsOIDC)
        XCTAssertEqual(manager.state, .loggedIn(server: activeURL))

        let result = await manager.addServerWithOIDC(
            serverURLString: newURL.absoluteString
        )

        XCTAssertEqual(result, .added(newURL))
        XCTAssertEqual(client.beginCount, 1)
        XCTAssertEqual(manager.state, .loggedIn(server: newURL))
        XCTAssertEqual(keychain.savedValues[.serverURL], newURL.absoluteString)
    }

    @MainActor
    func testAddServerOffersPasswordOrOIDCWhenBothAreAvailable() async throws {
        let client = OIDCMockAuthAPIClient(passwordAuthEnabled: true)
        let manager = AuthManager(
            keychain: InMemoryKeychainStore(),
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            serverRegistry: ServerRegistry.inMemory()
        )

        let result = await manager.addServer(
            serverURLString: "https://mixed-auth.test",
            password: ""
        )

        XCTAssertEqual(result, .needsPasswordOrOIDC)
        XCTAssertEqual(client.beginCount, 0)
        XCTAssertEqual(manager.state, .unconfigured)
    }

    func testServerCookieStoreIsolatesSameHostPortsAndRestoresFromKeychain() throws {
        let keychain = InMemoryKeychainStore()
        let legacy = try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let store = ServerCookieStore(keychain: keychain, legacyStorage: legacy)
        let first = try XCTUnwrap(URL(string: "https://same.test:8443"))
        let second = try XCTUnwrap(URL(string: "https://same.test:9443"))
        let firstCookie = try makeSessionCookie(value: "first")
        let secondCookie = try makeSessionCookie(value: "second")

        store.storage(for: first).setCookie(firstCookie)
        store.storage(for: second).setCookie(secondCookie)
        try store.persist(for: first)
        try store.persist(for: second)

        XCTAssertEqual(store.storage(for: first).cookies(for: first)?.map(\.value), ["first"])
        XCTAssertEqual(store.storage(for: second).cookies(for: second)?.map(\.value), ["second"])

        store.clear(for: first)
        XCTAssertTrue(store.storage(for: first).cookies?.isEmpty ?? true)
        XCTAssertEqual(store.storage(for: second).cookies(for: second)?.map(\.value), ["second"])

        let restored = ServerCookieStore(
            keychain: keychain,
            legacyStorage: try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        )
        XCTAssertTrue(restored.storage(for: first).cookies?.isEmpty ?? true)
        XCTAssertEqual(restored.storage(for: second).cookies(for: second)?.map(\.value), ["second"])
    }

    @MainActor
    func testSessionExpiryClearsOnlyExactSameHostServerCookieJar() throws {
        let keychain = InMemoryKeychainStore()
        let first = try XCTUnwrap(URL(string: "https://same.test:8443"))
        let second = try XCTUnwrap(URL(string: "https://same.test:9443"))
        try keychain.save(first.absoluteString, forKey: .serverURL)
        let registry = ServerRegistry.inMemory()
        registry.activate(url: second)
        registry.activate(url: first)
        let store = ServerCookieStore(
            keychain: keychain,
            legacyStorage: try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        )
        store.storage(for: first).setCookie(try makeSessionCookie(value: "first"))
        store.storage(for: second).setCookie(try makeSessionCookie(value: "second"))
        let manager = AuthManager(
            keychain: keychain,
            cookieStore: store,
            serverRegistry: registry
        )

        manager.handleAPIError(APIError.unauthorized)

        XCTAssertTrue(store.storage(for: first).cookies?.isEmpty ?? true)
        XCTAssertEqual(store.storage(for: second).cookies(for: second)?.map(\.value), ["second"])
        XCTAssertEqual(manager.state, .loggedOut(server: first))
    }

    private func makeSessionCookie(value: String) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .name: "hermes_session",
            .value: value,
            .domain: "same.test",
            .path: "/",
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(600)
        ]))
    }
}

private final class OIDCMockAuthAPIClient: AuthAPIClient, @unchecked Sendable {
    private let authorizationBaseURL: URL
    private let passwordAuthEnabled: Bool
    private let onExchange: () -> Void
    private let onLogout: () -> Void
    private let reportsLoggedInAfterExchange: Bool
    private(set) var state: String?
    private(set) var codeChallenge: String?
    private(set) var exchangeCodes: [String] = []
    private(set) var exchangeVerifiers: [String] = []
    private(set) var cancelledFlowIDs: [String] = []
    private(set) var beginCount = 0
    private(set) var logoutCount = 0

    init(
        authorizationBaseURL: URL = URL(string: "https://example.test")!,
        passwordAuthEnabled: Bool = false,
        onExchange: @escaping () -> Void = {},
        onLogout: @escaping () -> Void = {},
        reportsLoggedInAfterExchange: Bool = true
    ) {
        self.authorizationBaseURL = authorizationBaseURL
        self.passwordAuthEnabled = passwordAuthEnabled
        self.onExchange = onExchange
        self.onLogout = onLogout
        self.reportsLoggedInAfterExchange = reportsLoggedInAfterExchange
    }

    func health() async throws -> HealthResponse {
        HealthResponse(status: "ok", sessions: nil, activeStreams: nil, uptimeSeconds: nil)
    }

    func authStatus() async throws -> AuthStatusResponse {
        AuthStatusResponse(
            authEnabled: true,
            loggedIn: reportsLoggedInAfterExchange && !exchangeCodes.isEmpty,
            passwordAuthEnabled: passwordAuthEnabled,
            oidcEnabled: true,
            oidcNativeHandoffEnabled: true
        )
    }

    func login(password: String) async throws -> LoginResponse {
        XCTFail("Password login must not run during OIDC")
        return LoginResponse(ok: false, message: nil, error: nil)
    }

    func logout() async throws -> LoginResponse {
        logoutCount += 1
        onLogout()
        return LoginResponse(ok: true, message: nil, error: nil)
    }

    func beginNativeOIDC(
        callbackURL: URL,
        state: String,
        codeChallenge: String
    ) async throws -> NativeOIDCStartResponse {
        XCTAssertEqual(callbackURL.absoluteString, "talaria://oidc-callback")
        beginCount += 1
        self.state = state
        self.codeChallenge = codeChallenge
        return NativeOIDCStartResponse(
            flowId: "flow-1",
            authorizationUrl: authorizationBaseURL.appending(path: "/api/auth/oidc/start?native_flow=flow-1"),
            serverId: "server-1",
            expiresIn: 600
        )
    }

    func exchangeNativeOIDC(
        flowID: String,
        code: String,
        state: String,
        codeVerifier: String
    ) async throws -> LoginResponse {
        XCTAssertEqual(flowID, "flow-1")
        XCTAssertEqual(state, self.state)
        exchangeCodes.append(code)
        exchangeVerifiers.append(codeVerifier)
        onExchange()
        return LoginResponse(ok: true, message: nil, error: nil)
    }

    func cancelNativeOIDC(flowID: String, state: String) async throws -> LoginResponse {
        XCTAssertEqual(state, self.state)
        cancelledFlowIDs.append(flowID)
        return LoginResponse(ok: true, message: nil, error: nil)
    }
}

private final class ServerURLFailingKeychain: KeychainStoring {
    private let storage = InMemoryKeychainStore()

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        if key == .serverURL { throw CocoaError(.fileWriteNoPermission) }
        try storage.save(value, forKey: key)
    }

    func load(_ key: KeychainStore.Key) throws -> String? { try storage.load(key) }
    func delete(_ key: KeychainStore.Key) throws { try storage.delete(key) }
    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        try storage.save(value, forKey: key, scope: scope)
    }
    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        try storage.load(key, scope: scope)
    }
    func delete(_ key: KeychainStore.Key, scope: String) throws {
        try storage.delete(key, scope: scope)
    }
}
