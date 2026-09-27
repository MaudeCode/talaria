import XCTest
@testable import Talaria

final class OnboardingFlowTests: XCTestCase {
    @MainActor
    func testStaleSuccessfulProbeCannotReplaceCurrentFailure() async {
        let staleClient = DeferredOnboardingAuthClient()
        let currentClient = DeferredOnboardingAuthClient()
        let authManager = makeAuthManager(staleClient: staleClient, currentClient: currentClient)
        let viewModel = OnboardingViewModel()

        viewModel.serverURLString = "https://stale.example.test"
        let staleProbe = Task { await viewModel.testConnection(authManager: authManager) }
        await staleClient.waitUntilStarted()

        viewModel.serverURLString = "https://current.example.test"
        let currentProbe = Task { await viewModel.testConnection(authManager: authManager) }
        await currentClient.waitUntilStarted()
        await currentClient.complete(with: .failure(URLError(.cannotConnectToHost)))
        await currentProbe.value
        let currentError = viewModel.errorMessage

        await staleClient.complete(
            with: .success(AuthStatusResponse(authEnabled: false, loggedIn: false))
        )
        await staleProbe.value

        XCTAssertNil(viewModel.authStatus)
        XCTAssertNil(viewModel.connectionMessage)
        XCTAssertEqual(viewModel.errorMessage, currentError)
        XCTAssertFalse(viewModel.isWorking)
    }

    @MainActor
    func testStaleConfigureCannotReplaceCurrentAuthentication() async {
        let staleClient = DeferredOnboardingAuthClient()
        let currentClient = DeferredOnboardingAuthClient()
        let authManager = makeAuthManager(staleClient: staleClient, currentClient: currentClient)
        let viewModel = OnboardingViewModel()
        let successfulStatus = AuthStatusResponse(authEnabled: false, loggedIn: false)

        viewModel.serverURLString = "https://stale.example.test"
        viewModel.authStatus = successfulStatus
        let staleConnect = Task { await viewModel.connect(authManager: authManager) }
        await staleClient.waitUntilStarted()

        viewModel.serverURLString = "https://current.example.test"
        viewModel.authStatus = successfulStatus
        let currentConnect = Task { await viewModel.connect(authManager: authManager) }
        await currentClient.waitUntilStarted()
        await currentClient.complete(with: .success(successfulStatus))
        await currentConnect.value

        await staleClient.complete(with: .success(successfulStatus))
        await staleConnect.value

        XCTAssertEqual(
            authManager.state,
            .loggedIn(server: URL(string: "https://current.example.test")!)
        )
    }

    @MainActor
    func testEditingConnectionInputsClearsSuccessfulProbeState() {
        let viewModel = OnboardingViewModel(
            savedServer: URL(string: "https://server.example.test"),
            savedHeaders: [CustomHeader(name: "X-Test", value: "one")]
        )

        func recordSuccess() {
            viewModel.authStatus = AuthStatusResponse(authEnabled: false, loggedIn: false)
            viewModel.connectionMessage = "Connected"
        }

        recordSuccess()
        viewModel.serverURLString = "https://other.example.test"
        XCTAssertNil(viewModel.authStatus)
        XCTAssertNil(viewModel.connectionMessage)

        recordSuccess()
        viewModel.password = "new-password"
        XCTAssertNil(viewModel.authStatus)
        XCTAssertNil(viewModel.connectionMessage)

        recordSuccess()
        viewModel.customHeaders[0].value = "two"
        XCTAssertNil(viewModel.authStatus)
        XCTAssertNil(viewModel.connectionMessage)
    }

    func testPrimaryButtonTitlesFollowPagerFlow() {
        XCTAssertEqual(OnboardingFlowPolicy.primaryButtonTitle(for: 0), "Get Started")
        XCTAssertEqual(OnboardingFlowPolicy.primaryButtonTitle(for: 1), "Set Up")
        XCTAssertEqual(OnboardingFlowPolicy.primaryButtonTitle(for: 2), "Continue")
        XCTAssertEqual(OnboardingFlowPolicy.primaryButtonTitle(for: 3), "Continue")
        XCTAssertEqual(OnboardingFlowPolicy.primaryButtonTitle(for: 4), "Connect")
    }

    func testCopyReminderOnlyAppliesToAgentPromptPageWithoutCopy() {
        XCTAssertTrue(
            OnboardingFlowPolicy.shouldShowCopyReminder(
                page: OnboardingFlowPolicy.agentPromptPageIndex,
                hasCopiedAgentPrompt: false
            )
        )
        XCTAssertFalse(
            OnboardingFlowPolicy.shouldShowCopyReminder(
                page: OnboardingFlowPolicy.agentPromptPageIndex,
                hasCopiedAgentPrompt: true
            )
        )
        XCTAssertFalse(
            OnboardingFlowPolicy.shouldShowCopyReminder(
                page: OnboardingFlowPolicy.agentPromptPageIndex,
                hasCopiedAgentPrompt: false,
                hasBypassedCopyReminder: true
            )
        )
        XCTAssertFalse(
            OnboardingFlowPolicy.shouldShowCopyReminder(
                page: OnboardingFlowPolicy.connectPageIndex,
                hasCopiedAgentPrompt: false
            )
        )
    }

    func testForwardSwipeFromAgentPromptRequiresCopyOrBypass() {
        XCTAssertTrue(
            OnboardingFlowPolicy.shouldInterceptForwardNavigationFromAgentPrompt(
                from: OnboardingFlowPolicy.agentPromptPageIndex,
                to: 3,
                hasCopiedAgentPrompt: false
            )
        )
        XCTAssertFalse(
            OnboardingFlowPolicy.shouldInterceptForwardNavigationFromAgentPrompt(
                from: OnboardingFlowPolicy.agentPromptPageIndex,
                to: 3,
                hasCopiedAgentPrompt: true
            )
        )
        XCTAssertFalse(
            OnboardingFlowPolicy.shouldInterceptForwardNavigationFromAgentPrompt(
                from: OnboardingFlowPolicy.agentPromptPageIndex,
                to: 3,
                hasCopiedAgentPrompt: false,
                hasBypassedCopyReminder: true
            )
        )
        XCTAssertFalse(
            OnboardingFlowPolicy.shouldInterceptForwardNavigationFromAgentPrompt(
                from: OnboardingFlowPolicy.agentPromptPageIndex,
                to: 1,
                hasCopiedAgentPrompt: false
            )
        )
    }

    func testConnectFocusClearsWhenLeavingConnectPage() {
        XCTAssertTrue(OnboardingFlowPolicy.shouldClearConnectFocusWhenLeavingPage(3))
        XCTAssertFalse(OnboardingFlowPolicy.shouldClearConnectFocusWhenLeavingPage(OnboardingFlowPolicy.connectPageIndex))
    }

    func testServerShortcutShowsBeforeConnectPageOnly() {
        XCTAssertTrue(OnboardingFlowPolicy.showsServerShortcut(for: 0))
        XCTAssertTrue(OnboardingFlowPolicy.showsServerShortcut(for: 3))
        XCTAssertFalse(OnboardingFlowPolicy.showsServerShortcut(for: OnboardingFlowPolicy.connectPageIndex))
    }

    func testAgentSetupPromptDefaultsToSafeStateAwareTailscaleServe() {
        let prompt = OnboardingFlowPolicy.agentSetupPrompt

        let requiredInstructions = [
            "@maudecode/talaria-web",
            "npm install -g @maudecode/talaria-web",
            "Node 24 or newer",
            "command -v talaria-web",
            "talaria-web ctl start",
            "talaria-web ctl status",
            "talaria-web ctl restart",
            "If a service or another launcher runs Talaria Web, do not restart it yourself",
            "Inventory before changing anything",
            "command -v tailscale",
            "tailscale version",
            "tailscale status",
            "Only if `command -v tailscale` reports that Tailscale is absent",
            "correct method for this OS",
            "rerun `tailscale version`, `tailscale status`, and the authentication check",
            "tailscale serve status",
            "tailscale funnel status",
            "lsof -nP -iTCP:8787 -sTCP:LISTEN",
            "Do not kill an unknown process",
            "Do not run tailscale serve reset",
            "127.0.0.1:8787",
            "only if HTTPS port 443 at the root path is free",
            "tailscale serve --bg 8787",
            "Never enable Funnel",
            "HTTPS consent",
            "certificate-transparency disclosure",
            "umask 077",
            "chmod 600",
            "Preserve every existing line in `.env`",
            "only add or update the `HERMES_WEBUI_PASSWORD` entry",
            "If the running service or shell already sets `HERMES_WEBUI_PASSWORD`, that value wins over `.env`",
            "If Talaria Web runs from a source checkout, a `.env` in that checkout wins over both",
            "never truncate or replace the file",
            "Whether `.env` already existed or is new",
            "Do not print the full .env",
            "Do not configure auto-start yourself",
            "Propose the exact OS-appropriate commands and steps",
            "wait for me to run them",
            "Do not touch `~/Library/LaunchAgents/` or restart Mac services",
            "curl --fail http://127.0.0.1:8787/health",
            "confirm its JSON `status` is `ok`",
            "do not report setup as complete",
            "actual ts.net HTTPS URL",
            "exact HTTPS URL, password, launcher, and both health-check results",
            "manual fallback",
            "Do not automate it"
        ]

        for instruction in requiredInstructions {
            XCTAssertTrue(prompt.contains(instruction), "Missing safe setup instruction: \(instruction)")
        }

        for staleInstruction in ["hermes-webui", "bootstrap.py", "ctl.sh", "Python standard library"] {
            XCTAssertFalse(prompt.contains(staleInstruction), "Stale setup instruction: \(staleInstruction)")
        }
        XCTAssertFalse(prompt.contains("curl http://$(tailscale ip -4):8787/health"))
        XCTAssertFalse(prompt.contains("fall back: bind the server to 0.0.0.0"))
        XCTAssertFalse(prompt.contains("Otherwise configure auto-start appropriate for this OS"))
    }

    func testTailscaleAppStoreURLUsesITMSDeepLink() {
        XCTAssertEqual(
            OnboardingFlowPolicy.tailscaleAppStoreURL.absoluteString,
            "itms-apps://apps.apple.com/us/app/tailscale/id1470499037"
        )
        XCTAssertEqual(
            OnboardingFlowPolicy.tailscaleAppStoreFallbackURL.absoluteString,
            "https://apps.apple.com/us/app/tailscale/id1470499037"
        )
    }

    func testConnectPageIndexIsFinalPagerPage() {
        XCTAssertEqual(OnboardingFlowPolicy.connectPageIndex, OnboardingFlowPolicy.pageCount - 1)
    }

    @MainActor
    private func makeAuthManager(
        staleClient: DeferredOnboardingAuthClient,
        currentClient: DeferredOnboardingAuthClient
    ) -> AuthManager {
        let keychain = InMemoryKeychainStore()
        return AuthManager(
            keychain: keychain,
            clientFactory: { url in
                url.host == "stale.example.test" ? staleClient : currentClient
            },
            headerStore: CustomHeaderStore(),
            cookieStorage: HTTPCookieStorage(),
            profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: ServerRegistry.inMemory(keychain: keychain)
        )
    }
}

private actor DeferredOnboardingAuthClient: AuthAPIClient {
    private var responseContinuation: CheckedContinuation<AuthStatusResponse, Error>?
    private var startContinuation: CheckedContinuation<Void, Never>?
    private var didStart = false

    func health() async throws -> HealthResponse {
        HealthResponse(status: "ok", sessions: nil, activeStreams: nil, uptimeSeconds: nil)
    }

    func authStatus() async throws -> AuthStatusResponse {
        try await withCheckedThrowingContinuation { continuation in
            responseContinuation = continuation
            didStart = true
            startContinuation?.resume()
            startContinuation = nil
        }
    }

    func login(password: String) async throws -> LoginResponse {
        LoginResponse(ok: true, message: nil, error: nil)
    }

    func logout() async throws -> LoginResponse {
        LoginResponse(ok: true, message: nil, error: nil)
    }

    func waitUntilStarted() async {
        guard !didStart else { return }
        await withCheckedContinuation { startContinuation = $0 }
    }

    func complete(with result: Result<AuthStatusResponse, Error>) {
        responseContinuation?.resume(with: result)
        responseContinuation = nil
    }
}
