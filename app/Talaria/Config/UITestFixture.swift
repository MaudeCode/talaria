#if DEBUG
import AppIntents
import Foundation
import notify
import UIKit
import TalariaKit

@MainActor
struct UITestFixtureEnvironment {
    nonisolated static let launchArgument = UITestFixtureLaunch.launchArgument
    nonisolated static let relayConnectedArgument = UITestFixtureLaunch.relayConnectedArgument
    nonisolated static let reauthenticationArgument = "--ui-test-reauthentication"
    nonisolated static let trustedReauthenticationArgument = "--ui-test-reauthentication-trusted"
    /// Launches with no saved server so the fixture lands on onboarding.
    nonisolated static let onboardingArgument = "--ui-test-onboarding"
    /// Runs the "New Chat" App Intent at launch, so a UI test can exercise the real
    /// intent → `AppIntentRouter` → `ContentView` drain path (TAL-77). XCUITest has no
    /// supported way to run an App Intent through Shortcuts or Siri deterministically.
    nonisolated static let newChatIntentArgument = "--ui-test-intent-new-chat"
    /// Writes one shared-import draft while the app is backgrounded, the way the share
    /// extension does, so a UI test can reopen through `talaria://share` and see it import.
    nonisolated static let pendingShareArgument = "--ui-test-pending-share"
    nonisolated static let pendingShareDraft = "FixtureSharedDraft"
    /// Scales the deterministic transcript and session list up for the performance
    /// budgets (TAL-75). The functional fixtures keep the small counts so their
    /// scrolling and layout assertions stay fast.
    nonisolated static let denseArgument = "--ui-test-dense"
    nonisolated static let updateNotificationsArgument = "--ui-test-update-notifications"
    /// Answers the chat's first transcript load, so the cache exists, then holds every reopen
    /// until the test releases it, so "Syncing messages" stays over the cached rows (TAL-436).
    nonisolated static let holdTranscriptReloadsArgument = "--ui-test-hold-transcript-reloads"
    nonisolated static var isDense: Bool {
        ProcessInfo.processInfo.arguments.contains(denseArgument)
    }
    nonisolated static let serverURL = UITestFixtureLaunch.serverURL
    nonisolated static var relayCredentials: TalariaRelayCredentials { UITestFixtureLaunch.relayCredentials }

    let authManager: AuthManager
    let client: APIClient
    let draftStore: ChatDraftStore

    static func make() -> UITestFixtureEnvironment {
        let chatScenario = UITestChatScenario.current
        var initialDrafts: [ChatDraftKey: ChatDraft] = [:]
        if chatScenario == .clarification || chatScenario == .batchClarification {
            UITestChatFixtureState.shared.startChat()
            initialDrafts[.session(server: serverURL, sessionID: UITestFixtureURLProtocol.sessionID)] = ChatDraft(text: "Ordinary fixture draft")
        }
        UITestFixtureHold.shared.listen()
        UITestFixtureURLProtocol.WorkspaceFixture.listenForGitWriteGrant()
        // Theme is a standard-defaults preference a test can change, so every fixture
        // launch starts from the same appearance even if a previous run left it switched.
        UserDefaults.standard.set(AppTheme.system.rawValue, forKey: AppTheme.storageKey)
        // The alternate app icon is system-level state that outlives the app's own storage,
        // so clear it too: the icon picker must always start from the primary icon.
        if UIApplication.shared.alternateIconName != nil {
            UIApplication.shared.setAlternateIconName(nil)
        }
        // The chat toolbar's Files and Git controls are hideable in Settings, and the
        // workspace tests reach their destinations through them, so restore both.
        UserDefaults.standard.set(true, forKey: SectionVisibilitySettings.chatFilesKey)
        UserDefaults.standard.set(true, forKey: SectionVisibilitySettings.chatGitKey)
        UserDefaults.standard.set(
            StreamingSendBehavior.steer.rawValue,
            forKey: StreamingSendBehavior.storageKey
        )
        UserDefaults.standard.set(chatScenario == nil, forKey: StreamedTextAnimationSettings.isEnabledKey)
        UserDefaults.standard.set(true, forKey: ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey)
        UserDefaults.standard.set(
            chatScenario != nil,
            forKey: ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey
        )
        // Insights and the quota poll both persist across launches; a reused simulator
        // would otherwise replay one journey's analytics into the next one's empty or
        // error state.
        UserDefaults.standard.removeObject(forKey: InsightsResponseCache.storageKey)
        // The quota widget snapshot lives in the shared app group and is restored into the
        // provider view model at init, so a previous journey's sources would otherwise
        // reappear as "removed" rows in a fixture that reports none.
        _ = ProviderQuotaWidgetSnapshotStore().clear()
        UserDefaults.standard.set(
            ProviderQuotaRefreshInterval.defaultValue.rawValue,
            forKey: ProviderQuotaRefreshInterval.storageKey
        )

        prepareSharedImportInbox()
        if ProcessInfo.processInfo.arguments.contains(newChatIntentArgument) {
            Task { _ = try? await NewChatIntent().perform() }
        }

        let keychain = UITestFixtureKeychainStore(serverURL: serverURL)
        let defaultsName = "dev.kil.talaria.ui-test-fixture"
        let defaults = UserDefaults(suiteName: defaultsName)!
        defaults.removePersistentDomain(forName: defaultsName)
        CustomHeaderStore.shared.replace(with: [])
        let client = APIClient(baseURL: serverURL)
        return UITestFixtureEnvironment(
            authManager: AuthManager(
                keychain: keychain,
                clientFactory: { _ in client },
                probeClientFactory: { _, _, _ in client },
                headerStore: .shared,
                cookieStorage: URLSessionConfiguration.ephemeral.httpCookieStorage!,
                profileEntityCache: ProfileEntityCache(defaults: nil),
                serverRegistry: ServerRegistry(keychain: keychain, identityDefaults: defaults)
            ),
            client: client,
            draftStore: ChatDraftStore(persistence: UITestFixtureDraftPersistence(drafts: initialDrafts))
        )
    }
}

private extension UITestFixtureEnvironment {
    /// The shared-import inbox lives in the app group, outside the app's own storage, so a
    /// draft left by an earlier run would replay into this launch. Reuses the share host's
    /// reset (TAL-81), which removes the whole inbox: draining only the pending items would
    /// leave a record an interrupted run reserved, and an identical draft deduplicates
    /// against a reservation still holding its lease. Only this journey resets, so a test
    /// that relaunches to inspect what consumption left behind still sees it.
    static func prepareSharedImportInbox() {
        guard ProcessInfo.processInfo.arguments.contains(pendingShareArgument) else { return }
        ShareExtensionUITestHost.resetSharedState()
        guard let inbox = TalariaShareDraft.containerURL() else { return }
        // The extension writes its draft while Talaria is in the background, so the fixture
        // does too. Seeding at launch instead would let the initial import consume the draft
        // before any share URL was delivered, leaving the URL nothing to do.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            try? TalariaShareDraft.savePendingDraft(pendingShareDraft, in: inbox)
        }
    }
}

/// Responses held until the UI test posts `releaseNotification`, so a loading state stays up however long a
/// slow runner takes to find it (TAL-401). A release answers only the loads held when it lands and is never
/// banked for a later one, so one launch can hold several screens' loads in turn; the test repeats the release
/// until what it waits for appears, which also covers a request still on its way (TAL-402).
final class UITestFixtureHold: @unchecked Sendable {
    static let shared = UITestFixtureHold()
    /// Matches `TalariaUITestCase.releaseHeldLoads` in the UI tests.
    static let releaseNotification = "dev.kil.talaria.ui-test.release-held-loads"

    private let lock = NSLock()
    private var held: [() -> Void] = []
    private var token: Int32 = 0

    /// Registers at launch, before any screen can render the loading state the test answers.
    func listen() {
        notify_register_dispatch(Self.releaseNotification, &token, .global()) { [weak self] _ in
            self?.release()
        }
    }

    func hold(_ send: @escaping () -> Void) {
        lock.withLock { held.append(send) }
    }

    private func release() {
        let loads = lock.withLock {
            defer { held = [] }
            return held
        }
        loads.forEach { $0() }
    }
}

private final class UITestFixtureKeychainStore: KeychainStoring {
    private let lock = NSLock()
    private var values: [String: String]

    init(serverURL: URL) {
        values = ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.onboardingArgument)
            ? [:]
            : [KeychainStore.Key.serverURL.rawValue: serverURL.absoluteString]
    }

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        lock.withLock { values[key.rawValue] = value }
    }

    func load(_ key: KeychainStore.Key) throws -> String? {
        lock.withLock { values[key.rawValue] }
    }

    func delete(_ key: KeychainStore.Key) throws {
        _ = lock.withLock { values.removeValue(forKey: key.rawValue) }
    }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        lock.withLock { values[KeychainStore.scopedKey(key, scope: scope)] = value }
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        lock.withLock { values[KeychainStore.scopedKey(key, scope: scope)] }
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        _ = lock.withLock { values.removeValue(forKey: KeychainStore.scopedKey(key, scope: scope)) }
    }
}

private actor UITestFixtureDraftPersistence: ChatDraftPersisting {
    private var drafts: [ChatDraftKey: ChatDraft]

    init(drafts: [ChatDraftKey: ChatDraft] = [:]) { self.drafts = drafts }

    func load() async -> [ChatDraftKey: ChatDraft] { drafts }

    func write(_ drafts: [ChatDraftKey: ChatDraft]) async throws {
        self.drafts = drafts
    }
}

private enum UITestChatScenario: String, CaseIterable {
    case batchClarification = "--ui-test-chat-batch-clarification"
    case clarification = "--ui-test-chat-clarification"
    case full = "--ui-test-chat-full"
    case controls = "--ui-test-chat-controls"

    static var current: Self? {
        let arguments = ProcessInfo.processInfo.arguments
        return allCases.first { arguments.contains($0.rawValue) }
    }
}

private final class UITestChatFixtureState: @unchecked Sendable {
    static let shared = UITestChatFixtureState()

    private let condition = NSCondition()
    private var started = false
    private var settled = false
    private var approvalAnswered = false
    private var clarificationAnswered = false
    private var clarificationResponse = ""
    private var steerID: String?
    private var cancelled = false

    func startChat() {
        condition.lock()
        started = true
        condition.broadcast()
        condition.unlock()
    }

    func settle() {
        condition.lock()
        settled = true
        condition.broadcast()
        condition.unlock()
    }

    func answerApproval() {
        condition.lock()
        approvalAnswered = true
        condition.broadcast()
        condition.unlock()
    }

    func answerClarification(_ response: String) {
        condition.lock()
        clarificationAnswered = true
        clarificationResponse = response
        condition.broadcast()
        condition.unlock()
    }

    func receivedClarificationResponse() -> String {
        condition.lock()
        defer { condition.unlock() }
        return clarificationResponse
    }

    func acceptSteer(id: String?) {
        condition.lock()
        steerID = id
        condition.broadcast()
        condition.unlock()
    }

    func cancel() {
        condition.lock()
        cancelled = true
        settled = true
        condition.broadcast()
        condition.unlock()
    }

    func snapshot() -> (
        started: Bool,
        settled: Bool,
        approvalAnswered: Bool,
        clarificationAnswered: Bool,
        steerID: String?,
        cancelled: Bool
    ) {
        condition.lock()
        defer { condition.unlock() }
        return (started, settled, approvalAnswered, clarificationAnswered, steerID, cancelled)
    }

    func wait(until predicate: @escaping (UITestChatFixtureState) -> Bool, stopped: () -> Bool) {
        condition.lock()
        while !predicate(self), !stopped() {
            condition.wait()
        }
        condition.unlock()
    }

    func wakeWaiters() {
        condition.lock()
        condition.broadcast()
        condition.unlock()
    }

    fileprivate var approvalWasAnswered: Bool { approvalAnswered }
    fileprivate var clarificationWasAnswered: Bool { clarificationAnswered }
    fileprivate var acceptedSteerID: String? { steerID }
    fileprivate var wasCancelled: Bool { cancelled }
}

final class UITestFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    static let sessionID = "ui-fixture-session"
    static let sessionTitle = "UI Fixture Session"
    private static let recoveryState = NSLock()
    nonisolated(unsafe) private static var sessionReads = 0
    nonisolated(unsafe) private static var transcriptReads = 0
    nonisolated(unsafe) private static var recovered = false
    nonisolated(unsafe) private static var urgentNotificationAcknowledged = false
    nonisolated(unsafe) private static var readUpdateNotificationIDs: Set<String> = ["ui-update-succeeded"]
    nonisolated(unsafe) private static var dismissedUpdateNotificationIDs: Set<String> = []
    private static var testsReauthentication: Bool {
        ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.reauthenticationArgument)
    }
    private static var testsTrustedReauthentication: Bool {
        ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.trustedReauthenticationArgument)
    }
    private static let chatStreamID = "ui-fixture-stream"
    private static let chatState = UITestChatFixtureState.shared
    private let lifecycleLock = NSLock()
    private var stopped = false

    static func configure(_ configuration: URLSessionConfiguration) {
        guard ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.launchArgument) else { return }
        configuration.protocolClasses = [Self.self]
            + (configuration.protocolClasses ?? []).filter { $0 != Self.self }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == UITestFixtureEnvironment.serverURL.host
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        if UITestChatScenario.current != nil, url.path == "/api/chat/stream" {
            startScriptedChatStream(url: url)
            return
        }

        if let failure = Self.panelRequestFailure(for: url) {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }

        if Self.holdsPanelLoad(for: url) || Self.holdsWorkspaceRead(for: url) || Self.holdsTranscriptReload(for: url) {
            UITestFixtureHold.shared.hold { [weak self] in
                guard let self, !self.isStopped else { return }
                self.sendResponse(for: url)
            }
            return
        }

        sendResponse(for: url)
    }

    private static func holdsTranscriptReload(for url: URL) -> Bool {
        guard url.path == "/api/session",
              ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.holdTranscriptReloadsArgument)
        else { return false }
        return recoveryState.withLock {
            transcriptReads += 1
            return transcriptReads > 1
        }
    }

    private func sendResponse(for url: URL) {
        let isEventStream = url.path.hasSuffix("/stream")
        let contentType = Self.workspaceContentType(for: url)
            ?? (isEventStream ? "text/event-stream" : "application/json")
        let requiresSignIn = Self.recoveryState.withLock {
            if Self.testsReauthentication, url.path == "/api/sessions" {
                Self.sessionReads += 1
                if Self.testsTrustedReauthentication {
                    return Self.sessionReads > 1
                        && request.value(forHTTPHeaderField: "X-Fixture-Authorization") != "fixture-token"
                }
                return Self.sessionReads > 1 && !Self.recovered
            }
            if Self.testsReauthentication, url.path == "/api/auth/login" { Self.recovered = true }
            return false
        }
        var headers = ["Content-Type": contentType]
        if Self.testsReauthentication, url.path == "/api/auth/login" {
            headers["Set-Cookie"] = "hermes_session=fixture-renewed; Path=/; Secure; HttpOnly"
        }
        let response = HTTPURLResponse(
            url: url,
            statusCode: requiresSignIn ? 401 : Self.workspaceStatusCode(for: request),
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if UITestChatScenario.current != nil,
           url.path == "/api/approval/stream" || url.path == "/api/clarify/stream" {
            client?.urlProtocol(self, didLoad: Data(": fixture heartbeat\n\n".utf8))
            return
        }
        client?.urlProtocol(self, didLoad: Self.responseData(for: request))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        lifecycleLock.withLock { stopped = true }
        Self.chatState.wakeWaiters()
    }

    private static func responseData(for request: URLRequest) -> Data {
        guard let url = request.url else { return json([:]) }
        if let panelData = panelResponseData(for: request, url: url) { return panelData }
        if let workspaceData = workspaceResponseData(for: request) {
            return workspaceData
        }
        switch url.path {
        case "/health":
            return json(["status": "ok"])
        case "/api/auth/status":
            if testsTrustedReauthentication {
                return json([
                    "auth_enabled": true,
                    "logged_in": request.value(forHTTPHeaderField: "X-Fixture-Authorization") == "fixture-token",
                    "password_auth_enabled": false,
                    "trusted_auth_enabled": true
                ])
            }
            if testsReauthentication {
                let offersSSO = ProcessInfo.processInfo.arguments.contains("--ui-test-reauthentication-both")
                return json([
                    "auth_enabled": true, "logged_in": recoveryState.withLock { recovered },
                    "password_auth_enabled": true, "oidc_enabled": offersSSO,
                    "oidc_native_handoff_enabled": offersSSO
                ])
            }
            return json(["auth_enabled": false, "logged_in": true])
        case "/api/auth/login":
            return json(["ok": true])
        case "/api/sessions":
            return sessionsResponse(firstTitle: testsTrustedReauthentication
                && request.value(forHTTPHeaderField: "X-Fixture-Authorization") == "fixture-token"
                ? "Header recovery confirmed" : sessionTitle)
        case "/api/sessions/search":
            return json(["sessions": [], "query": "", "count": 0])
        case "/api/session":
            return UITestChatScenario.current == nil ? sessionResponse() : chatSessionResponse()
        case "/api/session/new":
            // The title echoes the requested profile so a UI test can see that a
            // "new chat in <profile>" entry point pinned the session (TAL-77).
            let requestedProfile = requestJSON(request)["profile"] as? String
            return json(["session": session(
                id: "ui-fixture-new-session",
                title: requestedProfile.map { "New Fixture Chat (\($0))" } ?? "New Fixture Chat"
            )])
        case "/api/upload":
            // Shared attachments upload before the composer can show them, so the
            // fixture has to accept one (TAL-81). Only a non-empty path is required;
            // the composer labels the chip with the local filename.
            return json([
                "path": "/fixture/uploads/shared",
                "mime": "application/octet-stream",
                "is_image": false
            ])
        case "/api/projects":
            return json(["projects": []])
        case "/api/profiles":
            return json([
                "profiles": [[
                    "name": "fixture-profile",
                    "display_name": "Fixture Profile",
                    "is_active": true,
                    "default_model": "fixture-model",
                    "provider": "fixture-provider"
                ]],
                "active": "fixture-profile",
                "single_profile_mode": false
            ])
        case "/api/providers":
            return json([
                "active_provider": "fixture-provider",
                "providers": [[
                    "id": "fixture-provider",
                    "display_name": "Fixture Provider",
                    "has_key": true,
                    "models": []
                ]]
            ])
        case "/api/provider/quotas":
            return providerQuotasResponse()
        case "/api/models":
            return json([
                "groups": [],
                "models": [["id": "fixture-model", "label": "Fixture Model"]],
                "default_model": "fixture-model",
                "active_provider": "fixture-provider"
            ])
        case "/api/workspaces":
            return json(["workspaces": [["path": "/fixture", "name": "Fixture Workspace"]]])
        case "/api/workspaces/suggest":
            return json(["suggestions": ["/fixture"], "prefix": "/fixture"])
        case "/api/commands":
            return json(["commands": []])
        case "/api/personalities":
            return json(["personalities": []])
        case "/api/skills":
            return json(["skills": []])
        case "/api/chat/start":
            chatState.startChat()
            return json(["stream_id": chatStreamID, "session_id": sessionID])
        case "/api/chat/cancel":
            chatState.cancel()
            return json(["ok": true, "cancelled": true, "stream_id": chatStreamID])
        case "/api/chat/stream/status":
            return json([
                "active": !chatState.snapshot().settled,
                "stream_id": chatStreamID,
                "replay_available": false
            ])
        case "/api/chat/steer":
            let steerID = requestJSON(request)["steer_id"] as? String
            chatState.acceptSteer(id: steerID)
            return json([
                "accepted": true,
                "stream_id": chatStreamID,
                "steer_id": steerID ?? "ui-fixture-steer"
            ])
        case "/api/approval/respond":
            chatState.answerApproval()
            return json(["ok": true, "choice": "once"])
        case "/api/approval/pending":
            return json(["pending_count": 0])
        case "/api/clarify/respond":
            let response = requestJSON(request)["response"] as? String ?? ""
            chatState.answerClarification(response)
            return json(["ok": !response.isEmpty, "response": response])
        case "/api/clarify/pending":
            return json(["pending_count": 0])
        case "/api/update-notifications":
            guard ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.updateNotificationsArgument) else {
                return json(["scope_id": "ui-fixture-scope", "notifications": [], "unread_count": 0, "clearable_count": 0, "can_clear": false])
            }
            return json(updateNotificationsEnvelope())
        case "/api/update-notifications/clear":
            recoveryState.withLock {
                dismissedUpdateNotificationIDs.formUnion(["ui-update-applying", "ui-update-blocked", "ui-update-succeeded"])
                if urgentNotificationAcknowledged { dismissedUpdateNotificationIDs.insert("ui-update-urgent") }
            }
            return json(updateNotificationsEnvelope())
        case let path where path.hasPrefix("/api/update-notifications/") && path.hasSuffix("/read"):
            let id = path.split(separator: "/").dropLast().last.map(String.init) ?? "ui-update-applying"
            _ = recoveryState.withLock { readUpdateNotificationIDs.insert(id) }
            return json(updateNotificationRecord(id: id))
        case let path where path.hasPrefix("/api/update-notifications/") && path.hasSuffix("/dismiss"):
            let id = path.split(separator: "/").dropLast().last.map(String.init) ?? ""
            recoveryState.withLock { dismissedUpdateNotificationIDs.insert(id); readUpdateNotificationIDs.insert(id) }
            return json(["ok": true])
        case let path where path.hasPrefix("/api/update-notifications/") && path.contains("/actions/"):
            recoveryState.withLock { urgentNotificationAcknowledged = true; readUpdateNotificationIDs.insert("ui-update-urgent") }
            return json(updateNotificationRecord(id: "ui-update-urgent"))
        case "/api/session/yolo":
            return json(["ok": true, "yolo_enabled": false])
        case "/api/chat/stream", "/api/approval/stream", "/api/clarify/stream", "/api/kanban/events/stream":
            return Data("event: stream_end\ndata: {}\n\n".utf8)
        default:
            return url.path.hasPrefix("/api/kanban/") ? kanbanResponseData(for: url) : json([:])
        }
    }

    private static func sessionsResponse(firstTitle: String) -> Data {
        let sessionCount = UITestFixtureEnvironment.isDense ? 300 : 18
        var sessions: [[String: Any]] = (0..<sessionCount).map { index in
            session(
                id: index == 0 ? sessionID : "ui-fixture-session-\(index)",
                title: index == 0 ? firstTitle : String(format: "Fixture Session %02d", index)
            )
        }
        return json(["sessions": sessions, "archived_count": 0])
    }

    private static func sessionResponse() -> Data {
        let messageCount = UITestFixtureEnvironment.isDense ? 600 : 48
        var messages: [[String: Any]] = (0..<messageCount).map { index in
            [
                "role": index.isMultiple(of: 2) ? "user" : "assistant",
                "content": "Fixture message \(index + 1) contains deterministic transcript content for scrolling.",
                "_ts": 2_000_000_000 + index
            ]
        }
        messages.append(contentsOf: linkInteractionMessages)
        if WorkspaceFixture.isEnabled {
            messages.append(workspaceFileLinkMessage)
        }
        var detail = session(id: sessionID, title: sessionTitle)
        detail["messages"] = messages
        return json(["session": detail])
    }

    /// A link to a workspace file with a line target, which the chat opens in
    /// the source viewer instead of handing to the system (TAL-169). Only the
    /// workspace fixture serves the file, so only it carries the message.
    private static let workspaceFileLinkMessage: [String: Any] = [
        "role": "assistant",
        "content": "See [FixtureFileLink](/fixture/\(WorkspaceFixture.textFileName):2) for the second line.",
        "message_id": "ui-fixture-file-link-assistant",
        "_ts": 2_000_000_102
    ]

    /// Mixed text-and-link content that pins deterministic long-press targets for
    /// the message-action interaction tests (TAL-49).
    private static let linkInteractionMessages: [[String: Any]] = [
        [
            "role": "user",
            "content": "Fixture link request",
            "message_id": "ui-fixture-link-user",
            "_ts": 2_000_000_100
        ],
        [
            "role": "assistant",
            "content": "FixturePlainLead \(String(repeating: "deterministic filler prose that makes this bubble tall. ", count: 12))"
                + "[FixtureLinkTarget](https://example.invalid/fixture-link) FixturePlainTail",
            "message_id": "ui-fixture-link-assistant",
            "_ts": 2_000_000_101
        ]
    ]

    private static func chatSessionResponse() -> Data {
        let state = chatState.snapshot()
        var detail = session(
            id: sessionID,
            title: state.settled && UITestChatScenario.current == .full
                ? "Deterministic Stream Complete"
                : sessionTitle
        )
        var messages: [[String: Any]] = []

        if state.started {
            messages.append([
                "role": "user",
                "content": "Run the deterministic fixture",
                "message_id": "ui-fixture-user",
                "_ts": 2_000_000_100
            ])
        }

        if state.settled, UITestChatScenario.current == .full {
            messages.append([
                "role": "assistant",
                "content": "Fixture opening. Fixture progress. Fixture finished.",
                "message_id": "ui-fixture-assistant",
                "_ts": 2_000_000_101,
                // As the server sends it: the rows under "Worked" exclude the answer, which rides in `final_answer`.
                "_anchor_activity_scene": [
                    "version": "activity_scene_v1",
                    "final_answer": "Fixture finished.",
                    "activity_rows": [
                        ["row_id": "prose-1", "order_index": 0, "role": "prose", "text": "Fixture opening."],
                        [
                            "row_id": "thinking-1",
                            "order_index": 1,
                            "role": "reasoning",
                            "text": "Inspect the fixture.",
                            "titles": ["Inspecting fixture"]
                        ],
                        ["row_id": "prose-2", "order_index": 2, "role": "prose", "text": "Fixture progress."],
                        [
                            "row_id": "tool:ui-fixture-tool",
                            "order_index": 3,
                            "role": "tool",
                            "tool": [
                                "id": "ui-fixture-tool",
                                "name": "fixture_tool",
                                "kind": "unknown",
                                "target": "",
                                "preview": "fixture result",
                                "result": "fixture result",
                                "done": true,
                                "is_error": false
                            ]
                        ]
                    ]
                ]
            ])
        } else if state.cancelled, UITestChatScenario.current == .controls {
            // As the server settles a stopped turn: the partial work, the steer it took, and the cancelled outcome.
            messages.append([
                "role": "assistant",
                "content": "",
                "message_id": "ui-fixture-cancelled",
                "_error": true,
                "_terminal_state": "cancelled",
                "_ts": 2_000_000_101,
                "_anchor_activity_scene": [
                    "version": "activity_scene_v1",
                    "final_answer": "",
                    "terminal_state": "cancelled",
                    "expanded_by_default": false,
                    "has_consumed_steering": true,
                    "activity_rows": [
                        ["row_id": "prose-1", "order_index": 0, "role": "prose", "text": "Waiting for control input."],
                        [
                            "row_id": "steering:ui-fixture-steer",
                            "order_index": 1,
                            "role": "steering",
                            "text": "Keep the fixture concise",
                            "steering": ["steer_id": "ui-fixture-steer", "consumed": true]
                        ]
                    ]
                ]
            ])
        }

        detail["messages"] = messages
        detail["message_count"] = messages.count
        detail["active_stream_id"] = state.started && !state.settled ? chatStreamID : NSNull()
        return json(["session": detail])
    }

    private static func session(id: String, title: String) -> [String: Any] {
        [
            "session_id": id,
            "title": title,
            "message_count": UITestFixtureEnvironment.isDense ? 600 : 48,
            "last_message_at": 2_000_000_000,
            "workspace": "/fixture",
            "model": "fixture-model",
            "model_provider": "fixture-provider",
            "profile": "fixture-profile",
            "archived": false
        ]
    }

    private static func providerQuotasResponse() -> Data {
        json([
            "version": 1,
            "scope_id": "ui-fixture-scope",
            "profile_id": "ui-fixture-profile",
            "active_provider": "fixture-provider",
            "sources": [[
                "source_id": "ui-fixture-source",
                "provider_id": "fixture-provider",
                "provider_label": "Fixture Provider",
                "account_label": "Fixture Account",
                "is_active_provider": true,
                "supported": true,
                "status": "available",
                "windows": [[
                    "label": "Session",
                    "used_percent": 25,
                    "remaining_percent": 75,
                    "reset_at": "2030-01-01T00:00:00Z"
                ]]
            ]]
        ])
    }

    private static func updateNotification(
        id: String,
        target: String,
        phase: String,
        title: String,
        message: String,
        updatedAt: String,
        readAt: Any
    ) -> [String: Any] {
        [
            "id": id,
            "kind": "update",
            "target": target,
            "phase": phase,
            "severity": phase == "blocked" ? "warning" : "info",
            "persistent": false,
            "requires_acknowledgement": false,
            "actions": [],
            "destination": ["key": "settings.system", "label": "Open System settings"],
            "title": title,
            "message": message,
            "created_at": updatedAt,
            "updated_at": updatedAt,
            "read_at": readAt,
            "acknowledged_at": NSNull(),
            "acknowledged_action_id": NSNull(),
            "verified_revision": phase == "succeeded" ? String(repeating: "a", count: 40) : NSNull(),
            "verified_version": phase == "succeeded" ? "web-v1.2.3" : NSNull(),
            "unread": readAt is NSNull,
            "active": phase == "applying" || phase == "restarting",
            "requires_interaction": false,
            "can_dismiss": true
        ]
    }

    private static func urgentUpdateNotification(acknowledged: Bool, read: Bool) -> [String: Any] {
        [
            "id": "ui-update-urgent",
            "kind": "system",
            "target": NSNull(),
            "phase": "attention",
            "severity": "critical",
            "persistent": true,
            "requires_acknowledgement": true,
            "actions": [["id": "acknowledge", "label": "Acknowledge", "style": "primary", "acknowledges": true]],
            "destination": ["key": "settings.system", "label": "Open System settings"],
            "title": "Action required",
            "message": "Please acknowledge this server notice before it can be cleared.",
            "created_at": "2026-09-26T13:24:00Z",
            "updated_at": "2026-09-26T13:24:00Z",
            "read_at": read ? "2026-09-26T13:25:00Z" : NSNull(),
            "acknowledged_at": acknowledged ? "2026-09-26T13:25:00Z" : NSNull(),
            "acknowledged_action_id": acknowledged ? "acknowledge" : NSNull(),
            "verified_revision": NSNull(),
            "verified_version": NSNull(),
            "unread": !read,
            "active": false,
            "requires_interaction": !acknowledged,
            "can_dismiss": acknowledged
        ]
    }

    private static func updateNotificationsEnvelope() -> [String: Any] {
        let snapshot = recoveryState.withLock {
            (urgentNotificationAcknowledged, readUpdateNotificationIDs, dismissedUpdateNotificationIDs)
        }
        let notifications = allUpdateNotifications(acknowledged: snapshot.0, readIDs: snapshot.1)
            .filter { !snapshot.2.contains($0["id"] as? String ?? "") }
        let clearableCount = notifications.filter {
            ($0["requires_acknowledgement"] as? Bool) != true || snapshot.0
        }.count
        return [
            "scope_id": "ui-fixture-scope",
            "notifications": notifications,
            "unread_count": notifications.filter { ($0["read_at"] as? NSNull) != nil }.count,
            "clearable_count": clearableCount,
            "can_clear": clearableCount > 0
        ]
    }

    private static func updateNotificationRecord(id: String) -> [String: Any] {
        let snapshot = recoveryState.withLock { (urgentNotificationAcknowledged, readUpdateNotificationIDs) }
        return allUpdateNotifications(acknowledged: snapshot.0, readIDs: snapshot.1)
            .first { ($0["id"] as? String) == id }
            ?? updateNotification(
                id: id,
                target: "webui",
                phase: "applying",
                title: "Talaria Web update",
                message: "Installing the selected Talaria Web update.",
                updatedAt: "2026-09-26T13:21:00Z",
                readAt: "2026-09-26T13:25:00Z"
            )
    }

    private static func allUpdateNotifications(acknowledged: Bool, readIDs: Set<String>) -> [[String: Any]] {
        [
            urgentUpdateNotification(acknowledged: acknowledged, read: readIDs.contains("ui-update-urgent")),
            updateNotification(
                id: "ui-update-applying", target: "webui", phase: "applying",
                title: "Talaria Web update", message: "Installing the selected Talaria Web update.",
                updatedAt: "2026-09-26T13:21:00Z", readAt: readIDs.contains("ui-update-applying") ? "2026-09-26T13:25:00Z" : NSNull()
            ),
            updateNotification(
                id: "ui-update-blocked", target: "agent", phase: "blocked",
                title: "Hermes Agent update", message: "The update is waiting for active work to finish.",
                updatedAt: "2026-09-26T13:13:00Z", readAt: readIDs.contains("ui-update-blocked") ? "2026-09-26T13:25:00Z" : NSNull()
            ),
            updateNotification(
                id: "ui-update-succeeded", target: "webui", phase: "succeeded",
                title: "Talaria Web update", message: "Talaria Web was updated successfully.",
                updatedAt: "2026-09-26T12:48:00Z", readAt: "2026-09-26T12:49:00Z"
            )
        ]
    }

    private static func json(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static func requestJSON(_ request: URLRequest) -> [String: Any] {
        guard let body = requestBody(request),
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return [:] }
        return object
    }

    /// `URLSession` hands `URLProtocol` a body stream instead of `httpBody` for the panel
    /// and chat mutations, so a fixture that only read `httpBody` saw every POST as empty.
    private static func requestBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data.isEmpty ? nil : data
    }

    private func startScriptedChatStream(url: URL) {
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.runChatScript()
        }
    }

    private func runChatScript() {
        guard let scenario = UITestChatScenario.current else { return }
        switch scenario {
        case .clarification, .batchClarification:
            var prompt: [String: Any] = [
                "clarify_id": "ui-fixture-draft-clarify",
                "question": "Which answer should continue?",
                "choices_offered": ["Use the deterministic path"],
                "session_id": Self.sessionID,
                "kind": "clarify"
            ]
            if scenario == .batchClarification {
                prompt["question"] = ""
                prompt["choices_offered"] = []
                prompt["questions"] = [
                    ["qid": "q0", "question": "What sounds best for a quiet evening?", "choices": ["A movie", "A book", "A game", "Some music"], "multi_select": false],
                    ["qid": "q1", "question": "Which drinks?", "choices": ["Tea", "Water"], "multi_select": true]
                ]
            }
            send(events: [("clarify", prompt)])
            wait { $0.clarificationWasAnswered }
            guard !isStopped else { return }
            Self.chatState.settle()
            let raw = Self.chatState.receivedClarificationResponse()
            var answer = raw
            if scenario == .batchClarification {
                // Like the Agent's batch callback, plain text has no answer map.
                let envelope = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]
                let answers = envelope?["answers"] as? [String: Any] ?? [:]
                answer = (answers["q0"] as? String ?? "") + " | "
                    + (answers["q1"] as? [String] ?? []).joined(separator: ", ")
            }
            send(events: [
                ("token", ["text": "Agent received: \(answer)"]),
                ("done", [:]), ("stream_end", [:])
            ])
            finish()
        case .full:
            send(events: [
                ("token", ["text": "Fixture opening."]),
                ("reasoning", ["text": "Inspect the fixture.", "titles": ["Inspecting fixture"]]),
                ("token", ["text": " Fixture progress."]),
                ("tool", [
                    "event_type": "tool.started",
                    "name": "fixture_tool",
                    "preview": "fixture input",
                    "args": ["target": "synthetic"],
                    "id": "ui-fixture-tool"
                ]),
                ("approval", [
                    "approval_id": "ui-fixture-approval",
                    "command": "fixture-tool --synthetic",
                    "description": "Allow the deterministic fixture to continue."
                ])
            ])
            wait { $0.approvalWasAnswered }
            guard !isStopped else { return }
            send(events: [
                ("tool_complete", [
                    "event_type": "tool.completed",
                    "name": "fixture_tool",
                    "preview": "fixture result",
                    "duration": 0.1,
                    "id": "ui-fixture-tool"
                ]),
                ("token", ["text": " Fixture finished."]),
                ("clarify", [
                    "clarify_id": "ui-fixture-clarify",
                    "question": "Which deterministic path should continue?",
                    "choices_offered": ["Use the deterministic path"],
                    "session_id": Self.sessionID,
                    "kind": "clarify"
                ])
            ])
            wait { $0.clarificationWasAnswered }
            guard !isStopped else { return }
            Self.chatState.settle()
            send(events: [
                ("title", ["session_id": Self.sessionID, "title": "Deterministic Stream Complete"]),
                ("metering", [
                    "session_id": Self.sessionID,
                    "tokens_per_second": 12.5,
                    "tps_available": true,
                    "estimated": false
                ]),
                ("done", [:]),
                ("stream_end", [:])
            ])
            finish()
        case .controls:
            send(events: [("token", ["text": "Waiting for control input."])])
            wait { $0.acceptedSteerID != nil || $0.wasCancelled }
            guard !isStopped else { return }
            if let steerID = Self.chatState.snapshot().steerID {
                send(events: [("steer_consumed", [
                    "session_id": Self.sessionID,
                    "stream_id": Self.chatStreamID,
                    "steer_id": steerID,
                    "text": "Keep the fixture concise"
                ])])
            }
            wait { $0.wasCancelled }
            guard !isStopped else { return }
            send(events: [("cancel", [:])])
            finish()
        }
    }

    private func wait(until predicate: @escaping (UITestChatFixtureState) -> Bool) {
        Self.chatState.wait(until: predicate, stopped: { [weak self] in self?.isStopped != false })
    }

    private var isStopped: Bool {
        lifecycleLock.withLock { stopped }
    }

    private func send(events: [(String, [String: Any])]) {
        guard !isStopped else { return }
        let data = events.reduce(into: Data()) { result, event in
            let payload = Self.json(event.1)
            result.append(Data("event: \(event.0)\ndata: ".utf8))
            result.append(payload)
            result.append(Data("\n\n".utf8))
        }
        client?.urlProtocol(self, didLoad: data)
    }

    private func finish() {
        guard !isStopped else { return }
        client?.urlProtocolDidFinishLoading(self)
    }
}
#endif
