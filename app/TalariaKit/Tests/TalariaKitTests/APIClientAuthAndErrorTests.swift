import XCTest
import CryptoKit
import SwiftData
@testable import TalariaKit

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

    func testForbiddenResponseShowsStructuredServerReasonWithoutPasswordGuidance() {
        let bodies = [
            #"{"error":"This session was imported read-only and cannot be continued."}"#,
            #"{"message":"This session was imported read-only and cannot be continued."}"#,
            #"{"detail":"This session was imported read-only and cannot be continued."}"#
        ]

        for body in bodies {
            let message = APIError.http(statusCode: 403, body: body).localizedDescription

            XCTAssertEqual(
                message,
                "The server refused the request: This session was imported read-only and cannot be continued.",
                "Body \(body) should surface its structured reason."
            )
            XCTAssertFalse(message.localizedCaseInsensitiveContains("password"))
        }
    }

    func testForbiddenResponseWithoutStructuredReasonUsesGenericRefusalCopy() {
        let bodies: [String?] = [
            nil,
            "",
            "   ",
            #"{"error":"   "}"#,
            #"{"error":}"#,
            "<html><body>Forbidden by WAF rule 42</body></html>"
        ]

        for body in bodies {
            let message = APIError.http(statusCode: 403, body: body).localizedDescription

            XCTAssertEqual(
                message,
                "The server refused the request. Check your access to this server.",
                "Body \(body ?? "nil") should fall back to generic refusal copy."
            )
            XCTAssertFalse(message.contains("<"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("WAF rule 42"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("password"))
        }
    }

    func testInterpolatedServerErrorsAreBoundedTo200Characters() {
        let reason = String(repeating: "n", count: 500)
        let body = #"{"error":"\#(reason)"}"#
        let bounded = String(repeating: "n", count: 199) + "\u{2026}"

        let cases: [(Int, String)] = [
            (400, "The server rejected the request: \(bounded)"),
            (403, "The server refused the request: \(bounded)"),
            (599, "Server returned HTTP 599: \(bounded)")
        ]

        for (statusCode, expected) in cases {
            let message = APIError.http(statusCode: statusCode, body: body).localizedDescription

            XCTAssertEqual(message, expected)
            XCTAssertFalse(message.contains(reason), "HTTP \(statusCode) echoed the unbounded server reason.")
        }

        // The untruncated reason still reaches classification and diagnostics.
        XCTAssertEqual(APIError.http(statusCode: 403, body: body).serverMessage, reason)
    }

    /// The bound counts Unicode scalars: a reason that is one extended grapheme
    /// cluster ("e" plus thousands of combining marks) would otherwise report
    /// `count == 1` and reach the alert whole.
    func testBoundedServerMessageCapsSingleGraphemeClusterReasons() throws {
        let reason = "e" + String(repeating: "\u{0301}", count: 5_000)
        let error = APIError.http(statusCode: 403, body: #"{"error":"\#(reason)"}"#)
        let prefix = "The server refused the request: "
        let message = error.localizedDescription

        let displayedReason = try XCTUnwrap(
            message.hasPrefix(prefix) ? String(message.dropFirst(prefix.count)) : nil,
            "403 message did not use the structured-reason copy: \(message)"
        )

        XCTAssertEqual(displayedReason.unicodeScalars.count, 200)
        XCTAssertFalse(message.contains(reason))
        XCTAssertEqual(error.serverMessage, reason, "Diagnostics keep the untruncated reason.")
    }

    func testUnauthorizedKeepsPasswordGuidanceAndLogCategory() {
        XCTAssertEqual(
            APIError.unauthorized.localizedDescription,
            "The password was rejected. Check the server password and try again."
        )
        XCTAssertEqual(APIError.unauthorized.privacySafeLogCategory, "unauthorized")
        XCTAssertEqual(APIError.http(statusCode: 403, body: #"{"error":"nope"}"#).privacySafeLogCategory, "http.403")
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

    func testUnresolvedOIDCConfigExplainsTemporaryUnavailability() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let unresolved = try decoder.decode(AuthStatusResponse.self, from: Data("""
        {"auth_enabled": true, "logged_in": false, "password_auth_enabled": false, "oidc_enabled": false,
         "oidc_native_handoff_enabled": false, "oidc_unavailable": true}
        """.utf8))

        XCTAssertEqual(
            AuthManager.unsupportedSignInMessage(for: unresolved),
            "Single sign-on is temporarily unavailable. Try again in a moment."
        )
        XCTAssertFalse(OnboardingViewModel.canSignInWithOIDC(status: unresolved))
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
        let keychain = InMemoryKeychainStore()
        let registryKeychain = RegistryFailingKeychain()
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStorage: cookies,
            serverRegistry: ServerRegistry(
                keychain: registryKeychain,
                identityDefaults: .ephemeral()
            )
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
        await fulfillment(of: [browserStarted], timeout: 10)

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

    @MainActor
    func testStaleOIDCFlowLogsOutWithoutCommittingServer() async throws {
        let keychain = InMemoryKeychainStore()
        let client = OIDCMockAuthAPIClient(
            authorizationBaseURL: try XCTUnwrap(URL(string: "https://stale.example.test"))
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )

        await manager.configureWithOIDC(
            serverURLString: "https://stale.example.test",
            canCommit: { false }
        )

        XCTAssertEqual(client.exchangeCodes, ["exchange-code"])
        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertEqual(manager.state, .unconfigured)
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
            XCTAssertEqual(request.httpMethod, "POST")
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
        try registry.activate(url: activeURL)
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
        XCTAssertEqual(keychain.scopedValue(.authenticatedProfile, scope: newURL.absoluteString), "member")
    }

    // MARK: - Server-bound profile reconciliation (TAL-131)

    @MainActor
    func testNativeOIDCReconcilesServerActiveProfileBeforeCommittingLogin() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let keychain = InMemoryKeychainStore()
        let cookieStore = ServerCookieStore(
            keychain: keychain,
            legacyStorage: ServerCookieStore.makeIsolatedStorage()
        )
        // Stale local identity left by a previous sign-in on the same server.
        try keychain.save("default", forKey: .authenticatedProfile, scope: server.absoluteString)
        var resets: [URL] = []
        var manager: AuthManager!
        let client = OIDCMockAuthAPIClient(
            onExchange: {
                cookieStore.storage(for: server).setCookie(
                    Self.makeCookie(name: "hermes_session", value: "member-session", for: server)
                )
            },
            onProfiles: {
                // The profile response is what carries `hermes_profile`; nothing
                // may have been persisted before it arrives.
                cookieStore.storage(for: server).setCookie(
                    Self.makeCookie(name: "hermes_profile", value: "member", for: server)
                )
                XCTAssertNil(keychain.scopedValue(.sessionCookies, scope: server.absoluteString))
            },
            profilesResult: .success(.synthetic(active: "member"))
        )
        manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: cookieStore,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: { url in
                resets.append(url)
                // The purge runs after reconciliation but before anything durable
                // is written or the logged-in UI is entered.
                XCTAssertEqual(client.callLog.last, "profiles")
                XCTAssertNil(keychain.scopedValue(.sessionCookies, scope: server.absoluteString))
                XCTAssertNotEqual(manager.state, .loggedIn(server: server))
            },
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )

        await manager.configureWithOIDC(serverURLString: server.absoluteString)

        XCTAssertEqual(client.callLog, ["authStatus", "exchange", "authStatus", "profiles"])
        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertNil(manager.lastErrorMessage)
        XCTAssertEqual(resets, [server])
        XCTAssertEqual(keychain.scopedValue(.authenticatedProfile, scope: server.absoluteString), "member")
        let persisted = try XCTUnwrap(keychain.scopedValue(.sessionCookies, scope: server.absoluteString))
        XCTAssertTrue(persisted.contains("hermes_session"))
        XCTAssertTrue(persisted.contains("hermes_profile"))
    }

    @MainActor
    func testNativeOIDCKeepsProfileScopedStateWhenTheSameProfileSignsInAgain() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let keychain = InMemoryKeychainStore()
        try keychain.save("member", forKey: .authenticatedProfile, scope: server.absoluteString)
        var resets: [URL] = []
        let client = OIDCMockAuthAPIClient(profilesResult: .success(.synthetic(active: "member")))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: ServerCookieStore(
                keychain: keychain,
                legacyStorage: ServerCookieStore.makeIsolatedStorage()
            ),
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: { resets.append($0) },
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )

        await manager.configureWithOIDC(serverURLString: server.absoluteString)

        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertTrue(resets.isEmpty)
        XCTAssertEqual(keychain.scopedValue(.authenticatedProfile, scope: server.absoluteString), "member")
    }

    @MainActor
    func testOIDCRecoveryPreservesCookiesOnCancellationAndDismissesOnSuccess() async throws {
        let server = URL(string: "https://example.test")!
        let keychain = InMemoryKeychainStore()
        try keychain.save(server.absoluteString, forKey: .serverURL)
        try keychain.save("member", forKey: .authenticatedProfile, scope: server.absoluteString)
        let cookies = ServerCookieStore.makeIsolatedStorage()
        cookies.setCookie(Self.makeCookie(name: "hermes_session", value: "old-cookie", for: server))
        let client = OIDCMockAuthAPIClient(onExchange: {
            cookies.setCookie(Self.makeCookie(name: "hermes_session", value: "new-cookie", for: server))
        })
        var cancel = true
        let manager = AuthManager(
            keychain: keychain, clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            webAuthenticator: { _, scheme in
                if cancel { throw OIDCSignInError.cancelled }
                return URL(string: "\(scheme)://oidc-callback?code=exchange-code&state=\(client.state!)&flow_id=flow-1&server_id=server-1")!
            },
            cookieStorage: cookies, profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )
        manager.handleAPIError(APIError.unauthorized)
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.pendingReauthentication, server)
        await manager.configureWithOIDC(serverURLString: server.absoluteString)
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertEqual(cookies.cookies(for: server)?.map(\.value), ["old-cookie"])
        XCTAssertEqual(client.logoutCount, 0)
        cancel = false
        await manager.configureWithOIDC(serverURLString: server.absoluteString)
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertEqual(manager.state, .loggedIn(server: server))
        XCTAssertEqual(manager.authenticatedIdentityRevision, 0)
        XCTAssertEqual(cookies.cookies(for: server)?.map(\.value), ["new-cookie"])
        let status = try await client.authStatus()
        XCTAssertTrue(status.isAlreadySignedIn)
    }

    func testRecoveryBlocksWritesAndUploadsButAllowsAuthAndReads() async throws {
        let server = URL(string: "https://example.test")!
        let owner = UUID()
        APIClient.setReauthenticationRequired(server, owner: owner)
        defer { APIClient.setReauthenticationRequired(nil, owner: owner) }
        let client = makeClient { request in
            XCTAssertTrue(["/health", "/api/auth/login"].contains(request.url!.path))
            return apiTestJSONResponse(request.url!.path == "/health" ? "{\"status\":\"ok\"}" : "{\"ok\":true}", for: request)
        }
        let response = try await client.login(password: "fixture-password")
        XCTAssertEqual(response.ok, true)
        let health = try await client.health()
        XCTAssertEqual(health.status, "ok")
        do {
            _ = try await client.sendData(endpoint: .health, method: "POST")
            XCTFail("Write was allowed")
        } catch APIError.unauthorized {} catch { XCTFail("Unexpected error: \(error)") }
        do {
            _ = try await client.uploadFile(sessionID: "fixture-session", data: Data(), filename: "fixture.txt")
            XCTFail("Upload was allowed")
        } catch APIError.unauthorized {} catch { XCTFail("Unexpected error: \(error)") }
        do {
            _ = try await client.transcribeAudio(data: Data(), filename: "fixture.wav")
            XCTFail("Transcription was allowed")
        } catch APIError.unauthorized {} catch { XCTFail("Unexpected error: \(error)") }
        APIClient.setReauthenticationRequired(nil, owner: owner)
        try await client.requireMutationAuthorization()
    }

    @MainActor
    func testPasswordSignInForgetsThePreviousOIDCProfileMarker() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let keychain = InMemoryKeychainStore()
        try keychain.save("member", forKey: .authenticatedProfile, scope: server.absoluteString)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in
                MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: true, loggedIn: false))
            },
            cookieStorage: URLSessionConfiguration.ephemeral.httpCookieStorage!,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )

        await manager.configure(serverURLString: server.absoluteString, password: "secret")

        XCTAssertEqual(manager.state, .loggedIn(server: server))
        // The next OIDC sign-in as "member" must reset, not trust this session's cache.
        XCTAssertNil(keychain.scopedValue(.authenticatedProfile, scope: server.absoluteString))
    }

    @MainActor
    func testNativeOIDCFailsClosedWithoutUsableActiveProfile() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let cases: [(String, Result<ProfilesResponse, Error>)] = [
            ("request failed", .failure(APIError.unauthorized)),
            ("missing active", .success(.synthetic(active: nil))),
            ("blank active", .success(.synthetic(active: "  "))),
            ("active not listed", .success(.synthetic(active: "ghost"))),
            ("no profile list", .success(ProfilesResponse(profiles: nil, active: "member"))),
        ]

        for (label, result) in cases {
            let keychain = InMemoryKeychainStore()
            let cookieStore = ServerCookieStore(
                keychain: keychain,
                legacyStorage: ServerCookieStore.makeIsolatedStorage()
            )
            let registry = ServerRegistry.inMemory(keychain: keychain)
            var resets: [URL] = []
            let client = OIDCMockAuthAPIClient(
                onExchange: {
                    cookieStore.storage(for: server).setCookie(
                        Self.makeCookie(name: "hermes_session", value: "partial-session", for: server)
                    )
                },
                profilesResult: result
            )
            let manager = AuthManager(
                keychain: keychain,
                clientFactory: { _ in client },
                webAuthenticator: { _, scheme in
                    try XCTUnwrap(URL(
                        string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                    ))
                },
                cookieStore: cookieStore,
                profileEntityCache: ProfileEntityCache(defaults: nil),
                resetServerScopedState: { resets.append($0) },
                serverRegistry: registry
            )

            await manager.configureWithOIDC(serverURLString: server.absoluteString)

            XCTAssertEqual(client.exchangeCodes, ["exchange-code"], label)
            XCTAssertEqual(client.logoutCount, 1, label)
            XCTAssertEqual(client.cancelledFlowIDs, [], label)
            XCTAssertEqual(manager.state, .unconfigured, label)
            XCTAssertNotNil(manager.lastErrorMessage, label)
            XCTAssertTrue(cookieStore.storage(for: server).cookies?.isEmpty ?? true, label)
            XCTAssertNil(keychain.scopedValue(.sessionCookies, scope: server.absoluteString), label)
            XCTAssertNil(keychain.scopedValue(.authenticatedProfile, scope: server.absoluteString), label)
            XCTAssertNil(keychain.savedValues[.serverURL], label)
            XCTAssertTrue(registry.servers.isEmpty, label)
            XCTAssertTrue(resets.isEmpty, label)
        }
    }

    @MainActor
    func testAddServerOIDCFailsClosedWithoutActiveProfileAndKeepsActiveServer() async throws {
        let activeURL = try XCTUnwrap(URL(string: "https://active.test"))
        let newURL = try XCTUnwrap(URL(string: "https://new.test"))
        let keychain = InMemoryKeychainStore()
        let cookieStore = ServerCookieStore(
            keychain: keychain,
            legacyStorage: ServerCookieStore.makeIsolatedStorage()
        )
        let registry = ServerRegistry.inMemory(keychain: keychain)
        try registry.activate(url: activeURL)
        try keychain.save(activeURL.absoluteString, forKey: .serverURL)
        try keychain.save("owner", forKey: .authenticatedProfile, scope: activeURL.absoluteString)
        cookieStore.storage(for: activeURL).setCookie(
            Self.makeCookie(name: "hermes_session", value: "active-session", for: activeURL)
        )
        try cookieStore.persist(for: activeURL)
        var resets: [URL] = []
        let client = OIDCMockAuthAPIClient(
            authorizationBaseURL: newURL,
            profilesResult: .success(.synthetic(active: "ghost"))
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: cookieStore,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: { resets.append($0) },
            serverRegistry: registry
        )

        let result = await manager.addServerWithOIDC(serverURLString: newURL.absoluteString)

        XCTAssertEqual(result, .failed)
        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertNotNil(manager.lastErrorMessage)
        // The previously active server, its cookies, and its profile are untouched.
        XCTAssertEqual(manager.state, .loggedIn(server: activeURL))
        XCTAssertEqual(registry.servers.map(\.id), [activeURL.absoluteString])
        XCTAssertEqual(keychain.savedValues[.serverURL], activeURL.absoluteString)
        XCTAssertEqual(
            cookieStore.storage(for: activeURL).cookies(for: activeURL)?.map(\.value),
            ["active-session"]
        )
        XCTAssertNotNil(keychain.scopedValue(.sessionCookies, scope: activeURL.absoluteString))
        XCTAssertEqual(keychain.scopedValue(.authenticatedProfile, scope: activeURL.absoluteString), "owner")
        // Nothing was committed for the attempted server.
        XCTAssertNil(keychain.scopedValue(.authenticatedProfile, scope: newURL.absoluteString))
        XCTAssertNil(keychain.scopedValue(.sessionCookies, scope: newURL.absoluteString))
        XCTAssertTrue(cookieStore.storage(for: newURL).cookies?.isEmpty ?? true)
        XCTAssertTrue(resets.isEmpty)
    }

    @MainActor
    func testNativeOIDCProfileChangeDropsCachedSessionsMessagesAndSelection() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let container = try ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        let context = container.mainContext
        let defaults = UserDefaults.ephemeral()
        // Offline data and a stored selection left by the previous identity.
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let staleSession = try decoder.decode(
            SessionSummary.self,
            from: Data(#"{"session_id": "stale-default", "title": "Old thread", "archived": false}"#.utf8)
        )
        try CacheStore.cacheSessions([staleSession], serverURL: server, in: context)
        try CacheStore.cacheMessages(
            [ChatMessage(role: "user", content: "hello", timestamp: 1, messageId: "m1")],
            serverURL: server,
            sessionID: "stale-default",
            in: context
        )
        SessionNavigationPersistence.save("stale-default", for: server, defaults: defaults)
        let draftPersistence = InMemoryChatDraftPersistence()
        let draftStore = ChatDraftStore(persistence: draftPersistence, debounceDuration: .seconds(10))
        draftStore.setDraft("unsent by default", for: .newChat(server: server))
        draftStore.setDraft("unsent in thread", for: .session(server: server, sessionID: "stale-default"))
        try await draftStore.flush()
        let keychain = InMemoryKeychainStore()
        try keychain.save("default", forKey: .authenticatedProfile, scope: server.absoluteString)
        let client = OIDCMockAuthAPIClient(profilesResult: .success(.synthetic(active: "member")))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: ServerCookieStore(
                keychain: keychain,
                legacyStorage: ServerCookieStore.makeIsolatedStorage()
            ),
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: AuthManager.serverScopedStateReset(
                cacheContainer: container,
                draftStore: draftStore,
                defaults: defaults
            ),
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )

        await manager.configureWithOIDC(serverURLString: server.absoluteString)

        XCTAssertEqual(manager.state, .loggedIn(server: server))
        // Even a failed first session-list request can no longer surface "default"'s data.
        XCTAssertTrue(try CacheStore.cachedSessions(serverURL: server, in: context).isEmpty)
        XCTAssertTrue(
            try CacheStore.cachedMessages(serverURL: server, sessionID: "stale-default", in: context).isEmpty
        )
        XCTAssertNil(SessionNavigationPersistence.load(for: server, defaults: defaults))
        let newChatDraft = await draftStore.draft(for: .newChat(server: server))
        XCTAssertNil(newChatDraft)
        let threadDraft = await draftStore.draft(for: .session(server: server, sessionID: "stale-default"))
        XCTAssertNil(threadDraft)
        // Removal is flushed to the persisted document (the debounce is 10s here),
        // so a relaunch cannot bring the previous profile's drafts back.
        let persistedDrafts = await draftPersistence.load()
        XCTAssertTrue(persistedDrafts.isEmpty)
    }

    @MainActor
    func testSignOutPurgesEveryServerScopedStoreAndLeavesTheOtherServerIntact() async throws {
        let signedOut = try XCTUnwrap(URL(string: "https://removed.test"))
        let kept = try XCTUnwrap(URL(string: "https://kept.test"))
        let container = try ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        let context = container.mainContext
        let defaults = UserDefaults.ephemeral()
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let insights = try decoder.decode(InsightsResponse.self, from: Data(#"{"total_sessions": 3}"#.utf8))
        let draftPersistence = InMemoryChatDraftPersistence()
        let draftStore = ChatDraftStore(persistence: draftPersistence, debounceDuration: .seconds(10))
        let responseCacheRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: responseCacheRoot) }
        // Seed identical server-scoped state for both servers.
        for (server, tag) in [(signedOut, "removed"), (kept, "kept")] {
            ResponseCache(server: server, root: responseCacheRoot).entry("projects")
                .save(Data(#"{"projects": [{"project_id": "\#(tag)"}]}"#.utf8))
            let session = try decoder.decode(
                SessionSummary.self,
                from: Data(#"{"session_id": "\#(tag)-session", "title": "Thread", "archived": false}"#.utf8)
            )
            try CacheStore.cacheSessions([session], serverURL: server, in: context)
            try CacheStore.cacheMessages(
                [ChatMessage(role: "user", content: "hello", timestamp: 1, messageId: "m1")],
                serverURL: server,
                sessionID: "\(tag)-session",
                in: context
            )
            SessionNavigationPersistence.save("\(tag)-session", for: server, defaults: defaults)
            defaults.set(false, forKey: SessionRowDisplaySettings.showCliSessionsKey(for: server))
            defaults.set(false, forKey: SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: server))
            InsightsResponseCache(server: server, defaults: defaults).save(insights, timeframe: .today)
            defaults.set("\(tag)-board", forKey: KanbanFeatureState.browsedBoardKey(for: server))
            draftStore.setDraft("unsent \(tag)", for: .newChat(server: server))
            draftStore.setAttachments(
                [ChatDraftAttachment(id: UUID(), name: "\(tag).png", mime: "image/png", size: 1, isImage: true, file: "\(tag).png")],
                for: .newChat(server: server)
            )
            ActiveChatStreamSnapshotStore.shared.save(.synthetic, server: server, sessionID: "\(tag)-session", streamID: "stream-1")
        }
        addTeardownBlock { ChatViewModel.resetActiveStreamSnapshotsForTesting() }
        try await draftStore.flush()
        let keychain = InMemoryKeychainStore()
        let registry = ServerRegistry.inMemory(keychain: keychain)
        try registry.activate(url: kept)
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStore: ServerCookieStore(
                keychain: keychain,
                legacyStorage: ServerCookieStore.makeIsolatedStorage()
            ),
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: AuthManager.serverScopedStateReset(
                cacheContainer: container,
                draftStore: draftStore,
                defaults: defaults,
                responseCacheRoot: responseCacheRoot
            ),
            serverRegistry: registry
        )
        await manager.configure(serverURLString: signedOut.absoluteString, password: "")
        XCTAssertEqual(manager.state, .loggedIn(server: signedOut))

        await manager.signOut()

        XCTAssertEqual(manager.state, .loggedIn(server: kept))
        XCTAssertTrue(try CacheStore.cachedSessions(serverURL: signedOut, in: context).isEmpty)
        XCTAssertTrue(try CacheStore.cachedMessages(serverURL: signedOut, sessionID: "removed-session", in: context).isEmpty)
        XCTAssertNil(SessionNavigationPersistence.load(for: signedOut, defaults: defaults))
        XCTAssertNil(defaults.object(forKey: SessionRowDisplaySettings.showCliSessionsKey(for: signedOut)))
        XCTAssertNil(defaults.object(forKey: SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: signedOut)))
        XCTAssertNil(InsightsResponseCache(server: signedOut, defaults: defaults).load(timeframe: .today))
        XCTAssertNil(defaults.string(forKey: KanbanFeatureState.browsedBoardKey(for: signedOut)))
        XCTAssertNil(ResponseCache(server: signedOut, root: responseCacheRoot).entry("projects").load(ProjectsResponse.self))
        XCTAssertEqual(
            ResponseCache(server: kept, root: responseCacheRoot).entry("projects").load(ProjectsResponse.self)?.projects?.compactMap(\.projectId),
            ["kept"]
        )
        let removedDraft = await draftStore.draft(for: .newChat(server: signedOut))
        XCTAssertNil(removedDraft)
        XCTAssertNil(ActiveChatStreamSnapshotStore.shared.snapshot(server: signedOut, sessionID: "removed-session", streamID: "stream-1"))
        XCTAssertEqual(
            ActiveChatStreamSnapshotStore.shared.snapshot(server: kept, sessionID: "kept-session", streamID: "stream-1"),
            .synthetic
        )
        // The other server's state is untouched, including the flushed draft document.
        XCTAssertEqual(try CacheStore.cachedSessions(serverURL: kept, in: context).count, 1)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: kept, sessionID: "kept-session", in: context).count, 1)
        XCTAssertEqual(SessionNavigationPersistence.load(for: kept, defaults: defaults), "kept-session")
        XCTAssertEqual(defaults.object(forKey: SessionRowDisplaySettings.showCliSessionsKey(for: kept)) as? Bool, false)
        XCTAssertEqual(defaults.object(forKey: SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: kept)) as? Bool, false)
        XCTAssertEqual(InsightsResponseCache(server: kept, defaults: defaults).load(timeframe: .today), insights)
        XCTAssertEqual(defaults.string(forKey: KanbanFeatureState.browsedBoardKey(for: kept)), "kept-board")
        let keptDraft = await draftStore.draft(for: .newChat(server: kept))
        XCTAssertEqual(keptDraft?.text, "unsent kept")
        XCTAssertEqual(keptDraft?.attachments.map(\.file), ["kept.png"])
        let persistedDrafts = await draftPersistence.load()
        XCTAssertEqual(persistedDrafts.keys.map(\.serverID), [kept.absoluteString])
    }

    @MainActor
    func testSignOutStillClearsTheCacheWhenTheDraftFlushFails() async throws {
        let server = try XCTUnwrap(URL(string: "https://removed.test"))
        let container = try ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        let context = container.mainContext
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(
            SessionSummary.self,
            from: Data(#"{"session_id": "s1", "title": "Thread", "archived": false}"#.utf8)
        )
        try CacheStore.cacheSessions([session], serverURL: server, in: context)
        let draftStore = ChatDraftStore(persistence: FailingChatDraftPersistence(), debounceDuration: .seconds(10))
        draftStore.setDraft("unsent", for: .newChat(server: server))
        let keychain = InMemoryKeychainStore()
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(authEnabled: false)) },
            cookieStore: ServerCookieStore(
                keychain: keychain,
                legacyStorage: ServerCookieStore.makeIsolatedStorage()
            ),
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: AuthManager.serverScopedStateReset(
                cacheContainer: container,
                draftStore: draftStore,
                defaults: UserDefaults.ephemeral()
            ),
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )
        await manager.configure(serverURLString: server.absoluteString, password: "")

        await manager.signOut()

        // The failed draft write neither blocks the other deletion nor undoes sign-out.
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNil(manager.lastErrorMessage)
        XCTAssertTrue(try CacheStore.cachedSessions(serverURL: server, in: context).isEmpty)
        let draft = await draftStore.draft(for: .newChat(server: server))
        XCTAssertNil(draft)
    }

    @MainActor
    func testNativeOIDCSupersededBeforeProfileResetNeverPurgesLocalState() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let keychain = InMemoryKeychainStore()
        let cookieStore = ServerCookieStore(
            keychain: keychain,
            legacyStorage: ServerCookieStore.makeIsolatedStorage()
        )
        let registry = ServerRegistry.inMemory(keychain: keychain)
        var inputRevision = 0
        var resetCount = 0
        let client = OIDCMockAuthAPIClient(
            onExchange: {
                cookieStore.storage(for: server).setCookie(
                    Self.makeCookie(name: "hermes_session", value: "member-session", for: server)
                )
            },
            // The user edits the connect form while the profile fetch is suspended.
            onProfiles: { inputRevision += 1 },
            profilesResult: .success(.synthetic(active: "member"))
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: cookieStore,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: { _ in resetCount += 1 },
            serverRegistry: registry
        )

        await manager.configureWithOIDC(
            serverURLString: server.absoluteString,
            canCommit: { inputRevision == 0 }
        )

        // An abandoned attempt must not destroy drafts or cache for that server.
        XCTAssertEqual(resetCount, 0)
        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNil(manager.lastErrorMessage)
        XCTAssertTrue(cookieStore.storage(for: server).cookies?.isEmpty ?? true)
        XCTAssertNil(keychain.scopedValue(.authenticatedProfile, scope: server.absoluteString))
        XCTAssertTrue(registry.servers.isEmpty)
    }

    @MainActor
    func testNativeOIDCAbandonsAttemptSupersededDuringProfileReset() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let keychain = InMemoryKeychainStore()
        let cookieStore = ServerCookieStore(
            keychain: keychain,
            legacyStorage: ServerCookieStore.makeIsolatedStorage()
        )
        let registry = ServerRegistry.inMemory(keychain: keychain)
        var inputRevision = 0
        let client = OIDCMockAuthAPIClient(
            onExchange: {
                cookieStore.storage(for: server).setCookie(
                    Self.makeCookie(name: "hermes_session", value: "member-session", for: server)
                )
            },
            profilesResult: .success(.synthetic(active: "member"))
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: cookieStore,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            // The user edits the connect form while the purge is suspended.
            resetServerScopedState: { _ in inputRevision += 1 },
            serverRegistry: registry
        )

        await manager.configureWithOIDC(
            serverURLString: server.absoluteString,
            canCommit: { inputRevision == 0 }
        )

        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNil(manager.lastErrorMessage)
        XCTAssertTrue(cookieStore.storage(for: server).cookies?.isEmpty ?? true)
        XCTAssertNil(keychain.scopedValue(.sessionCookies, scope: server.absoluteString))
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertTrue(registry.servers.isEmpty)
    }

    @MainActor
    func testNativeOIDCFailsClosedWhenProfileScopedPurgeFails() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let keychain = InMemoryKeychainStore()
        let cookieStore = ServerCookieStore(
            keychain: keychain,
            legacyStorage: ServerCookieStore.makeIsolatedStorage()
        )
        let registry = ServerRegistry.inMemory(keychain: keychain)
        try keychain.save("default", forKey: .authenticatedProfile, scope: server.absoluteString)
        let client = OIDCMockAuthAPIClient(
            onExchange: {
                cookieStore.storage(for: server).setCookie(
                    Self.makeCookie(name: "hermes_session", value: "member-session", for: server)
                )
            },
            profilesResult: .success(.synthetic(active: "member"))
        )
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            webAuthenticator: { _, scheme in
                try XCTUnwrap(URL(
                    string: "\(scheme)://oidc-callback?code=exchange-code&state=\(try XCTUnwrap(client.state))&flow_id=flow-1&server_id=server-1"
                ))
            },
            cookieStore: cookieStore,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            resetServerScopedState: { _ in throw CocoaError(.fileWriteUnknown) },
            serverRegistry: registry
        )

        await manager.configureWithOIDC(serverURLString: server.absoluteString)

        // The previous profile's data could not be purged, so nothing is committed
        // and the old marker stays so the next sign-in retries the purge.
        XCTAssertEqual(manager.state, .unconfigured)
        XCTAssertNotNil(manager.lastErrorMessage)
        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertTrue(cookieStore.storage(for: server).cookies?.isEmpty ?? true)
        XCTAssertNil(keychain.scopedValue(.sessionCookies, scope: server.absoluteString))
        XCTAssertNil(keychain.savedValues[.serverURL])
        XCTAssertTrue(registry.servers.isEmpty)
        XCTAssertEqual(keychain.scopedValue(.authenticatedProfile, scope: server.absoluteString), "default")
    }

    private static func makeCookie(name: String, value: String, for server: URL) -> HTTPCookie {
        HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: server.host ?? "",
            .path: "/",
            .secure: "TRUE",
        ])!
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

    func testServerCookieStorePersistsLegacyCookieBeforeDeletingSource() throws {
        let keychain = InMemoryKeychainStore()
        let legacy = try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        legacy.cookies?.forEach(legacy.deleteCookie)
        let server = try XCTUnwrap(URL(string: "https://same.test"))
        legacy.setCookie(try makeSessionCookie(value: "legacy"))

        let store = ServerCookieStore(keychain: keychain, legacyStorage: legacy)

        XCTAssertEqual(store.storage(for: server).cookies(for: server)?.map(\.value), ["legacy"])
        XCTAssertTrue(legacy.cookies(for: server)?.isEmpty ?? true)

        let restored = ServerCookieStore(
            keychain: keychain,
            legacyStorage: try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        )
        XCTAssertEqual(restored.storage(for: server).cookies(for: server)?.map(\.value), ["legacy"])
    }

    func testServerCookieStoreKeepsLegacyCookieWhenMigrationPersistenceFails() throws {
        let keychain = InMemoryKeychainStore()
        keychain.saveError = NSError(domain: "ServerCookieStoreTests", code: 1)
        let legacy = try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        legacy.cookies?.forEach(legacy.deleteCookie)
        let server = try XCTUnwrap(URL(string: "https://same.test"))
        legacy.setCookie(try makeSessionCookie(value: "legacy"))

        let store = ServerCookieStore(keychain: keychain, legacyStorage: legacy)

        XCTAssertEqual(store.storage(for: server).cookies(for: server)?.map(\.value), ["legacy"])
        XCTAssertEqual(legacy.cookies(for: server)?.map(\.value), ["legacy"])
    }

    @MainActor
    func testSessionExpiryPreservesExactSameHostServerCookieJars() async throws {
        let keychain = InMemoryKeychainStore()
        let first = try XCTUnwrap(URL(string: "https://same.test:8443"))
        let second = try XCTUnwrap(URL(string: "https://same.test:9443"))
        try keychain.save(first.absoluteString, forKey: .serverURL)
        let registry = ServerRegistry.inMemory()
        try registry.activate(url: second)
        try registry.activate(url: first)
        let store = ServerCookieStore(
            keychain: keychain,
            legacyStorage: try XCTUnwrap(URLSessionConfiguration.ephemeral.httpCookieStorage)
        )
        store.storage(for: first).setCookie(try makeSessionCookie(value: "first"))
        store.storage(for: second).setCookie(try makeSessionCookie(value: "second"))
        let manager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in MockAuthAPIClient(authStatus: AuthStatusResponse(loggedIn: false)) },
            probeClientFactory: { _, _, _ in MockAuthAPIClient(authStatus: AuthStatusResponse(loggedIn: false)) },
            cookieStore: store,
            serverRegistry: registry
        )

        manager.handleAPIError(APIError.unauthorized)

        await manager.recoveryTask?.value
        XCTAssertEqual(store.storage(for: first).cookies(for: first)?.map(\.value), ["first"])
        XCTAssertEqual(store.storage(for: second).cookies(for: second)?.map(\.value), ["second"])
        XCTAssertEqual(manager.state, .loggedIn(server: first))
        XCTAssertEqual(manager.pendingReauthentication, first)
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

    /// The auth family has no other request-interception test, so a GET/POST
    /// swap in `APIClient` would otherwise stay green (TAL-122).
    func testAuthRequestsUseTheirDocumentedMethods() async throws {
        var observedMethods: [String: String] = [:]
        let client = makeClient { request in
            observedMethods[request.url?.path ?? "nil"] = request.httpMethod

            if request.url?.path == "/api/auth/oidc/native/start" {
                return apiTestJSONResponse("""
                {
                  "flow_id": "flow-1",
                  "authorization_url": "https://idp.test/authorize",
                  "server_id": "server-1",
                  "expires_in": 300
                }
                """, for: request)
            }

            return apiTestJSONResponse(#"{"ok": true}"#, for: request)
        }

        _ = try await client.health()
        _ = try await client.authStatus()
        _ = try await client.login(password: "hunter2")
        _ = try await client.logout()
        _ = try await client.beginNativeOIDC(
            callbackURL: try XCTUnwrap(URL(string: "talaria://oidc-callback")),
            state: "state-1",
            codeChallenge: "challenge-1"
        )
        _ = try await client.cancelNativeOIDC(flowID: "flow-1", state: "state-1")

        XCTAssertEqual(observedMethods, [
            "/health": "GET",
            "/api/auth/status": "GET",
            "/api/auth/login": "POST",
            "/api/auth/logout": "POST",
            "/api/auth/oidc/native/start": "POST",
            "/api/auth/oidc/native/cancel": "POST"
        ])
    }
}

private actor FailingChatDraftPersistence: ChatDraftPersisting {
    func load() async -> [ChatDraftKey: ChatDraft] { [:] }

    func write(_ drafts: [ChatDraftKey: ChatDraft]) async throws {
        throw CocoaError(.fileWriteUnknown)
    }
}

private actor InMemoryChatDraftPersistence: ChatDraftPersisting {
    private var drafts: [ChatDraftKey: ChatDraft] = [:]

    func load() async -> [ChatDraftKey: ChatDraft] { drafts }

    func write(_ drafts: [ChatDraftKey: ChatDraft]) async throws {
        self.drafts = drafts
    }
}

private extension ProfilesResponse {
    /// `GET /api/profiles` for a server with synthetic `default` and `member`
    /// profiles, with `active` set verbatim so blank or unlisted names can be
    /// exercised.
    static func synthetic(active: String?) -> ProfilesResponse {
        ProfilesResponse(
            profiles: ["default", "member"].map { name in
                ProfileSummary(
                    name: name,
                    path: nil,
                    isDefault: name == "default",
                    isActive: name == active,
                    gatewayRunning: nil,
                    model: nil,
                    provider: nil,
                    hasEnv: nil,
                    skillCount: nil
                )
            },
            active: active,
            singleProfileMode: false
        )
    }
}

private final class OIDCMockAuthAPIClient: AuthAPIClient, @unchecked Sendable {
    private let authorizationBaseURL: URL
    private let passwordAuthEnabled: Bool
    private let onExchange: () -> Void
    private let onLogout: () -> Void
    private let onProfiles: () -> Void
    private let reportsLoggedInAfterExchange: Bool
    private let profilesResult: Result<ProfilesResponse, Error>
    private(set) var state: String?
    private(set) var codeChallenge: String?
    private(set) var exchangeCodes: [String] = []
    private(set) var exchangeVerifiers: [String] = []
    private(set) var cancelledFlowIDs: [String] = []
    private(set) var beginCount = 0
    private(set) var logoutCount = 0
    /// Auth-relevant calls in order: `authStatus`, `exchange`, `profiles`.
    private(set) var callLog: [String] = []

    init(
        authorizationBaseURL: URL = URL(string: "https://example.test")!,
        passwordAuthEnabled: Bool = false,
        onExchange: @escaping () -> Void = {},
        onLogout: @escaping () -> Void = {},
        onProfiles: @escaping () -> Void = {},
        reportsLoggedInAfterExchange: Bool = true,
        profilesResult: Result<ProfilesResponse, Error> = .success(.synthetic(active: "member"))
    ) {
        self.authorizationBaseURL = authorizationBaseURL
        self.passwordAuthEnabled = passwordAuthEnabled
        self.onExchange = onExchange
        self.onLogout = onLogout
        self.onProfiles = onProfiles
        self.reportsLoggedInAfterExchange = reportsLoggedInAfterExchange
        self.profilesResult = profilesResult
    }

    func health() async throws -> HealthResponse {
        HealthResponse(status: "ok", sessions: nil, activeStreams: nil, uptimeSeconds: nil)
    }

    func profiles() async throws -> ProfilesResponse {
        callLog.append("profiles")
        onProfiles()
        return try profilesResult.get()
    }

    func authStatus() async throws -> AuthStatusResponse {
        callLog.append("authStatus")
        return AuthStatusResponse(
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
        callLog.append("exchange")
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

private final class RegistryFailingKeychain: KeychainStoring {
    private let storage = InMemoryKeychainStore()

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        if key == .servers { throw CocoaError(.fileWriteNoPermission) }
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
