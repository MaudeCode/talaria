#if DEBUG
import Foundation
import os
import UIKit
import TalariaKit

@MainActor
struct UITestFixtureEnvironment {
    nonisolated static let launchArgument = UITestFixtureLaunch.launchArgument
    nonisolated static let approvalBypassArgument = "--ui-test-approval-bypass"
    /// Serves a transcript of very long bodies in the server's collapsed shape (TAL-456), the
    /// shape that ran the App out of memory before it rendered excerpts.
    nonisolated static let longBodiesArgument = "--ui-test-long-bodies"
    /// Serves a long pasted prompt the server marked `_collapsible` (TAL-452).
    nonisolated static let longPromptArgument = "--ui-test-long-prompt"
    /// Serves a reply with `diff`, `patch`, `log` and `text` code blocks (TAL-447).
    nonisolated static let diffBlocksArgument = "--ui-test-diff-blocks"
    /// Serves a reply whose media references the server rewrote for display (TAL-186), and the media bytes.
    nonisolated static let transcriptMediaArgument = "--ui-test-transcript-media"
    /// Serves a transcript with automatic background wakeups in the server's `_background_update` shape (TAL-371).
    nonisolated static let backgroundUpdatesArgument = "--ui-test-background-updates"
    /// Serves a compacted chat whose reference card the server placed after its second row (TAL-560).
    nonisolated static let compressionReferenceArgument = "--ui-test-compression-reference"
    /// Serves the fixture chat as a branch of "Fixture Session 01", which opens with its own transcript (TAL-454).
    nonisolated static let branchedFromArgument = "--ui-test-branched-from"
    /// Answers the chat's first transcript load, so the cache exists, then holds every reopen
    /// until the test releases it, so "Syncing messages" stays over the cached rows (TAL-436).
    nonisolated static let holdTranscriptReloadsArgument = "--ui-test-hold-transcript-reloads"
    /// Holds every `/api/sessions` read until the test releases it, so a relaunch shows what it
    /// painted from cache (TAL-437).
    nonisolated static let holdSessionListArgument = "--ui-test-hold-session-list"
    /// Fails the first `/api/session/new` with a server error, so a UI test can see a new chat's
    /// composer report it and retry (TAL-636).
    nonisolated static let failFirstSessionCreationArgument = "--ui-test-fail-first-session-creation"
    /// Keeps a chat archive's Undo offered for the whole test, so the five-second expiry cannot run
    /// out while a slow runner snapshots the list before tapping Undo (TAL-650). TalariaKit's
    /// `SessionListArchiveUndoTests` covers the expiry itself.
    nonisolated static let holdArchiveUndoArgument = "--ui-test-hold-archive-undo"
    /// Opens the Chats list with its update notifications sheet up.
    nonisolated static let updateNotificationsArgument = "--ui-test-update-notifications"

    /// The fixture's response-cache directory, emptied once per launch.
    nonisolated static let responseCacheRoot: URL? = {
        guard ProcessInfo.processInfo.arguments.contains(launchArgument) else { return nil }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ui-test-response-cache", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        return root
    }()
    nonisolated static var hasLongBodies: Bool {
        ProcessInfo.processInfo.arguments.contains(longBodiesArgument)
    }
    nonisolated static var hasLongPrompt: Bool {
        ProcessInfo.processInfo.arguments.contains(longPromptArgument)
    }
    nonisolated static var hasDiffBlocks: Bool {
        ProcessInfo.processInfo.arguments.contains(diffBlocksArgument)
    }
    nonisolated static var hasTranscriptMedia: Bool {
        ProcessInfo.processInfo.arguments.contains(transcriptMediaArgument)
    }
    nonisolated static var hasBackgroundUpdates: Bool {
        ProcessInfo.processInfo.arguments.contains(backgroundUpdatesArgument)
    }
    nonisolated static var hasCompressionReference: Bool {
        ProcessInfo.processInfo.arguments.contains(compressionReferenceArgument)
    }
    nonisolated static var hasBranchedFrom: Bool {
        ProcessInfo.processInfo.arguments.contains(branchedFromArgument)
    }
    nonisolated static let serverURL = UITestFixtureLaunch.serverURL

    let authManager: AuthManager
    let client: APIClient
    let draftStore: ChatDraftStore

    static func make() -> UITestFixtureEnvironment {
        let chatScenario = UITestChatScenario.current
        var initialDrafts: [ChatDraftKey: ChatDraft] = [:]
        let fixtureSessionDraft = ChatDraftKey.session(server: serverURL, sessionID: UITestFixtureURLProtocol.sessionID)
        if chatScenario == .clarification || chatScenario == .batchClarification {
            UITestChatFixtureState.shared.startChat()
            initialDrafts[fixtureSessionDraft] = ChatDraft(text: "Ordinary fixture draft")
        }
        // Theme is a standard-defaults preference a test can change, so every fixture
        // launch starts from the same appearance even if a previous run left it switched.
        UserDefaults.standard.set(AppTheme.system.rawValue, forKey: AppTheme.storageKey)
        // The alternate app icon is system-level state that outlives the app's own storage,
        // so clear it too: the icon picker must always start from the primary icon.
        if UIApplication.shared.alternateIconName != nil {
            UIApplication.shared.setAlternateIconName(nil)
        }
        // The chat toolbar's Files and Git controls are hideable in Settings, so every launch shows both.
        UserDefaults.standard.set(true, forKey: SectionVisibilitySettings.chatFilesKey)
        UserDefaults.standard.set(true, forKey: SectionVisibilitySettings.chatGitKey)
        // Tests reach the composer's controls through its strip, so every launch starts with it shown.
        UserDefaults.standard.set(true, forKey: ComposerVisibilitySettings.controlStripKey)
        UserDefaults.standard.set(
            StreamingSendBehavior.steer.rawValue,
            forKey: StreamingSendBehavior.storageKey
        )
        UserDefaults.standard.set(ComposerSendKey.defaultValue.rawValue, forKey: ComposerSendKey.storageKey)
        UserDefaults.standard.set(
            ComposerSTTProviderPreference.defaultValue.rawValue,
            forKey: ComposerSTTProviderPreference.storageKey
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

        // Response Complete Alerts start off and unasked, so a journey turns them on in Settings.
        UserDefaults.standard.set(false, forKey: ResponseCompletionNotifications.isEnabledKey)
        UserDefaults.standard.removeObject(forKey: ResponseCompletionNotifications.hasRequestedPermissionKey)
        // The scheduled and webhook groups start collapsed and the Tasks sections open, as on a fresh install, rather
        // than as an earlier test left them on this simulator.
        UserDefaults.standard.removeObject(forKey: SessionSidebarDisclosureSettings.scheduledSessionsAreExpandedKey)
        UserDefaults.standard.removeObject(forKey: SessionSidebarDisclosureSettings.webhookSessionsAreExpandedKey)
        UserDefaults.standard.removeObject(forKey: TaskSidebarDisclosureKeys.recentCompletions)
        UserDefaults.standard.removeObject(forKey: TaskSidebarDisclosureKeys.scheduledJobs)

        let keychain = UITestFixtureKeychainStore(serverURL: serverURL)
        let defaultsName = "dev.kil.talaria.ui-test-fixture"
        let defaults = UserDefaults(suiteName: defaultsName)!
        defaults.removePersistentDomain(forName: defaultsName)
        CustomHeaderStore.shared.replace(with: [])
        let client = APIClient(baseURL: serverURL)
        let authManager = AuthManager(
            keychain: keychain,
            clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client },
            headerStore: .shared,
            cookieStorage: URLSessionConfiguration.ephemeral.httpCookieStorage!,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: ServerRegistry(keychain: keychain, identityDefaults: defaults)
        )
        return UITestFixtureEnvironment(
            authManager: authManager,
            client: client,
            draftStore: ChatDraftStore(persistence: UITestFixtureDraftPersistence(drafts: initialDrafts))
        )
    }
}

/// Responses held until the test calls `release()`, so a loading state stays up however long a slow runner takes
/// to find it (TAL-401). A release answers only the loads held when it lands and is never banked for a later one, so
/// one test can hold several screens' loads in turn (TAL-402).
final class UITestFixtureHold: @unchecked Sendable {
    static let shared = UITestFixtureHold()

    private let lock = NSLock()
    private var held: [() -> Void] = []

    func hold(_ send: @escaping () -> Void) {
        lock.withLock { held.append(send) }
    }

    /// Sends every held load.
    func release() {
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
        values = [KeychainStore.Key.serverURL.rawValue: serverURL.absoluteString]
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

    init(drafts: [ChatDraftKey: ChatDraft] = [:]) {
        self.drafts = drafts
    }

    func load() async -> [ChatDraftKey: ChatDraft] {
        drafts
    }

    func write(_ drafts: [ChatDraftKey: ChatDraft]) async throws {
        self.drafts = drafts
    }
}

private enum UITestChatScenario: String, CaseIterable {
    case batchClarification = "--ui-test-chat-batch-clarification"
    case clarification = "--ui-test-chat-clarification"
    case full = "--ui-test-chat-full"
    case controls = "--ui-test-chat-controls"
    /// TAL-426: a pending steer from another device, with the server's Send now, Edit and Cancel.
    case pendingSteers = "--ui-test-chat-pending-steers"

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
    private var clarificationAnswers: [String: Any] = [:]
    private var steerID: String?
    private var withdrawnSteerID: String?
    private var cancelled = false

    /// A fresh launch's state, for hosted tests that start the fixture once per test (TAL-856).
    func reset() {
        condition.lock()
        started = false
        settled = false
        approvalAnswered = false
        clarificationAnswered = false
        clarificationAnswers = [:]
        steerID = nil
        withdrawnSteerID = nil
        cancelled = false
        condition.broadcast()
        condition.unlock()
    }

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

    func answerClarification(_ answers: [String: Any]) {
        condition.lock()
        clarificationAnswered = true
        clarificationAnswers = answers
        condition.broadcast()
        condition.unlock()
    }

    func receivedClarificationAnswers() -> [String: Any] {
        condition.lock()
        defer { condition.unlock() }
        return clarificationAnswers
    }

    func acceptSteer(id: String?) {
        condition.lock()
        steerID = id
        condition.broadcast()
        condition.unlock()
    }

    func withdrawSteer(id: String?) {
        condition.lock()
        withdrawnSteerID = id
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

    /// Waits for `predicate`, calling `heartbeat` every few seconds meanwhile. The server's stream heartbeats while
    /// a run waits; without one the App's stall watchdog shows "Checking stream" after 12 s and reconnects at 18 s,
    /// moving the controls a test is about to tap (TAL-666).
    func wait(until predicate: @escaping (UITestChatFixtureState) -> Bool, stopped: () -> Bool, heartbeat: () -> Void) {
        condition.lock()
        while !predicate(self), !stopped() {
            if !condition.wait(until: Date().addingTimeInterval(3)) {
                condition.unlock()
                heartbeat()
                condition.lock()
            }
        }
        condition.unlock()
    }

    func steerWithdrawnIDSnapshot() -> String? {
        condition.lock()
        defer { condition.unlock() }
        return withdrawnSteerID
    }

    func wakeWaiters() {
        condition.lock()
        condition.broadcast()
        condition.unlock()
    }

    fileprivate var approvalWasAnswered: Bool { approvalAnswered }
    fileprivate var clarificationWasAnswered: Bool { clarificationAnswered }
    fileprivate var acceptedSteerID: String? { steerID }
    fileprivate var steerWithdrawnID: String? { withdrawnSteerID }
    fileprivate var wasCancelled: Bool { cancelled }
}

final class UITestFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    static let sessionID = "ui-fixture-session"
    static let sessionTitle = "UI Fixture Session"
    private static let recoveryState = NSLock()
    nonisolated(unsafe) private static var approvalBypassOverride: Bool?
    /// The session's toolsets as the fixture saved them (TAL-631); nil is the profile's defaults.
    private static let sessionToolsets = OSAllocatedUnfairLock<[String]?>(initialState: nil)
    nonisolated(unsafe) private static var transcriptReads = 0
    nonisolated(unsafe) private static var archivedSessionIDs: Set<String> = []
    private static let chatStreamID = "ui-fixture-stream"
    static let pendingSteerID = "steer-ui-fixture-web"
    static let pendingSteerText = "Check the backup logs too"
    private static let chatState = UITestChatFixtureState.shared
    private let lifecycleLock = NSLock()
    private var stopped = false
    /// Bumped by each hosted test's reset: a load an earlier test started counts as stopped, so its scripted stream
    /// ends instead of answering the next test's scenario (TAL-856).
    private static let generation = OSAllocatedUnfairLock(initialState: 0)
    private static let generationHeader = "X-UI-Fixture-Generation"
    private let startedGeneration = UITestFixtureURLProtocol.generation.withLock { $0 }

    /// Puts the fixture's per-launch server state back to a fresh launch's, for hosted tests that start the fixture in
    /// process once per test (TAL-856).
    static func resetForHostedTest() {
        generation.withLock { $0 += 1 }
        approvalBypassOverride = nil
        sessionToolsets.withLock { $0 = nil }
        transcriptReads = 0
        archivedSessionIDs = []
        backgroundDismissed.withLock { $0 = false }
        didFailSessionCreation = false
        chatState.reset()
    }

    static func configure(_ configuration: URLSessionConfiguration) {
        guard ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.launchArgument) else { return }
        configuration.protocolClasses = [Self.self]
            + (configuration.protocolClasses ?? []).filter { $0 != Self.self }
        // A session remembers the hosted test it was made in, so a screen an earlier test left running cannot reach the
        // next test's scenario (TAL-856).
        var headers = configuration.httpAdditionalHeaders ?? [:]
        headers[generationHeader] = String(generation.withLock { $0 })
        configuration.httpAdditionalHeaders = headers
        // A held load waits for the test's release, not for URLSession's 60 s default: XCTest's own wait for the App to
        // go idle blocked a hosted test for 58 s, and the held Git status read failed before its release (TAL-672).
        configuration.timeoutIntervalForRequest = .infinity
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
        if let made = request.value(forHTTPHeaderField: Self.generationHeader), made != String(Self.generation.withLock { $0 }) {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }

        if UITestChatScenario.current != nil, url.path == "/api/chat/stream" {
            startScriptedChatStream(url: url)
            return
        }

        let holdsSessionList = url.path == "/api/sessions"
            && ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.holdSessionListArgument)
        if Self.holdsTranscriptReload(for: url) || holdsSessionList {
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
        let contentType = url.path.hasSuffix("/stream") ? "text/event-stream" : "application/json"
        let response = HTTPURLResponse(
            url: url,
            statusCode: Self.failsSessionCreation(url) ? 500 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": contentType]
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

    private static let sessionCreationFailureLock = NSLock()
    nonisolated(unsafe) private static var didFailSessionCreation = false

    /// True once, for the first new-chat request, under `--ui-test-fail-first-session-creation`.
    private static func failsSessionCreation(_ url: URL) -> Bool {
        guard url.path == "/api/session/new",
              ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.failFirstSessionCreationArgument)
        else { return false }
        return sessionCreationFailureLock.withLock {
            defer { didFailSessionCreation = true }
            return !didFailSessionCreation
        }
    }

    private static func responseData(for request: URLRequest) -> Data {
        guard let url = request.url else { return json([:]) }
        switch url.path {
        case "/health":
            return json(["status": "ok"])
        case "/api/auth/status":
            return json(["auth_enabled": false, "logged_in": true])
        case "/api/auth/login":
            return json(["ok": true])
        case "/api/sessions" where URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .contains { $0.name == "include_archived" && $0.value == "1" } == true:
            return archivedSessionsResponse()
        case "/api/sessions":
            return sessionsResponse()
        case "/api/session/archive":
            let body = requestJSON(request)
            if let id = body["session_id"] as? String, let archived = body["archived"] as? Bool {
                recoveryState.withLock {
                    if archived { archivedSessionIDs.insert(id) } else { archivedSessionIDs.remove(id) }
                }
            }
            return json(["ok": true])
        case "/api/sessions/search":
            // TAL-308: the server answers from the `/api/sessions` rows for the sidebar's project and visibility
            // filters, in their order, and the App shows exactly that set; title matches stand in for its title,
            // metadata and content search (`SessionService.sidebarSearch`).
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
            let query = value("q") ?? ""
            let projectID = value("project_id")
            let hiddenKinds = [
                ("cli", "show_cli_sessions"), ("claude_code", "show_claude_code_sessions"),
                ("cron", "show_cron_sessions"), ("webhook", "show_webhook_sessions")
            ].filter { value($0.1) == "0" }.map(\.0)
            let list = (try? JSONSerialization.jsonObject(with: sessionsResponse())) as? [String: Any]
            let matches = (list?["sessions"] as? [[String: Any]] ?? []).filter { row in
                let rowProject = row["project_id"] as? String
                if let projectID, projectID == "none" ? rowProject != nil : rowProject != projectID { return false }
                if let kind = row["source_kind"] as? String, hiddenKinds.contains(kind) { return false }
                return query.isEmpty || (row["title"] as? String)?.localizedCaseInsensitiveContains(query) == true
            }
            return json(["sessions": matches, "query": query, "count": matches.count, "sidebar_filtered": true])
        case "/api/sessions/bulk":
            let ids = requestJSON(request)["session_ids"] as? [String] ?? []
            return json(["results": ids.map { ["session_id": $0, "ok": true] }])
        case "/api/session" where UITestFixtureEnvironment.hasBranchedFrom:
            return branchedSessionResponse(url)
        case "/api/session":
            return UITestChatScenario.current == nil ? sessionResponse() : chatSessionResponse()
        case "/api/media" where UITestFixtureEnvironment.hasTranscriptMedia:
            return url.query?.contains(".mp3") == true ? transcriptMediaAudio : transcriptMediaImage
        case "/api/background/tasks" where UITestFixtureEnvironment.hasBackgroundUpdates:
            return json(["session_id": sessionID, "agent_available": true, "tasks": Self.backgroundTasks()])
        case "/api/background/result" where UITestFixtureEnvironment.hasBackgroundUpdates:
            return json(["task_id": "bg-ui", "text": Self.backgroundResultText])
        case "/api/background/dismiss" where UITestFixtureEnvironment.hasBackgroundUpdates:
            Self.backgroundDismissed.withLock { $0 = true }
            return json(["ok": true, "task": Self.backgroundTasks()[1]])
        case "/api/session/tool-result":
            return json([
                "tool_call_id": "ui-fixture-tool",
                "result": "fixture result, in full",
                "result_view": ["text": "fixture result, in full"]
            ])
        case "/api/session/new":
            // The title echoes the requested profile so a UI test can see that a
            // "new chat in <profile>" entry point pinned the session (TAL-77).
            let body = requestJSON(request)
            let requestedProfile = body["profile"] as? String
            let created = session(
                id: newSessionID,
                title: requestedProfile.map { "New Fixture Chat (\($0))" } ?? "New Fixture Chat"
            )
            return json(["session": created])
        case "/api/upload":
            // Shared attachments upload before the composer can show them, so the
            // fixture has to accept one (TAL-81). Only a non-empty path is required;
            // the composer labels the chip with the local filename. An image upload
            // reports itself as one, as the server does, so the composer shows its
            // thumbnail (TAL-634).
            let body = requestBody(request).map { String(decoding: $0, as: UTF8.self) } ?? ""
            let isImage = [".jpg\"", ".jpeg\"", ".png\"", ".heic\""].contains { body.localizedCaseInsensitiveContains($0) }
            return json([
                "path": "/fixture/uploads/shared",
                "mime": isImage ? "image/jpeg" : "application/octet-stream",
                "is_image": isImage
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
                    "is_active": true,
                    "key_source": "env_file",
                    "key_source_kind": "env",
                    "models": [],
                    "models_total": 0
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
        case "/api/model/auxiliary":
            return json(auxiliaryModelsResponse())
        case "/api/model/set":
            return json(["ok": true, "auxiliary": auxiliaryModelsResponse()])
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
        case "/api/chat/steer/withdraw":
            let steerID = requestJSON(request)["steer_id"] as? String
            chatState.withdrawSteer(id: steerID)
            return json(["withdrawn": true, "text": Self.pendingSteerText])
        case "/api/chat/steer/send-now":
            return json(["redirected": false])
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
            let answers = requestJSON(request)["answers"] as? [String: Any] ?? [:]
            chatState.answerClarification(answers)
            return json(["ok": !answers.isEmpty])
        case "/api/clarify/pending":
            return json(["pending_count": 0])
        case "/api/update-notifications":
            return json(["scope_id": "ui-fixture-scope", "notifications": [], "unread_count": 0, "clearable_count": 0, "can_clear": false])
        case "/api/session/toolsets":
            // Like the server: trimmed, blanks dropped, nothing left is the profile's defaults.
            let names = (requestJSON(request)["toolsets"] as? [String] ?? [])
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            let saved = names.isEmpty ? nil : names
            sessionToolsets.withLock { $0 = saved }
            return json(["ok": true, "enabled_toolsets": saved.map { $0 as Any } ?? NSNull()])
        case "/api/session/yolo":
            let requested = request.httpMethod == "POST" ? requestJSON(request)["enabled"] as? Bool : nil
            let enabled = recoveryState.withLock {
                if let requested { approvalBypassOverride = requested }
                return approvalBypassOverride
                    ?? ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.approvalBypassArgument)
            }
            return json(["ok": true, "yolo_enabled": enabled])
        case "/api/chat/stream", "/api/approval/stream", "/api/clarify/stream", "/api/kanban/events/stream":
            return Data("event: stream_end\ndata: {}\n\n".utf8)
        default:
            return url.path.hasPrefix("/api/kanban/") ? kanbanResponseData(for: url) : json([:])
        }
    }

    private static func sessionsResponse() -> Data {
        let archivedIDs = recoveryState.withLock { archivedSessionIDs }
        let sessions: [[String: Any]] = (0..<18).map { index in
            session(
                id: index == 0 ? sessionID : "ui-fixture-session-\(index)",
                title: index == 0 ? sessionTitle : String(format: "Fixture Session %02d", index)
            )
        }.filter { !archivedIDs.contains($0["session_id"] as? String ?? "") }
        return json(["sessions": sessions, "archived_count": 0])
    }

    /// The one archived row, which only the archived-sessions screen requests.
    private static func archivedSessionsResponse() -> Data {
        var archived = session(id: "ui-fixture-archived-session", title: "Fixture Archived Session")
        archived["archived"] = true
        archived["message_count"] = 3
        return json(["sessions": [archived], "archived_count": 1])
    }

    private static func sessionResponse() -> Data {
        if UITestFixtureEnvironment.hasCompressionReference {
            var detail = session(id: sessionID, title: sessionTitle)
            detail["messages"] = [
                ["role": "user", "content": "Plan the migration.", "message_id": "reference-prompt", "_ts": 2_000_000_000, "_turn_id": "plan"],
                ["role": "assistant", "content": "Here is the plan.", "message_id": "reference-plan", "_ts": 2_000_000_001, "_turn_id": "plan"],
                ["role": "user", "content": "Start step one.", "message_id": "reference-step", "_ts": 2_000_000_002, "_turn_id": "step"],
                ["role": "assistant", "content": "Step one done.", "message_id": "reference-done", "_ts": 2_000_000_003, "_turn_id": "step"]
            ]
            detail["compression_reference"] = ["text": "Earlier turns were summarised.", "after_message_index": 1]
            return json(["session": detail])
        }
        if UITestFixtureEnvironment.hasBackgroundUpdates {
            var detail = session(id: sessionID, title: sessionTitle)
            detail["messages"] = backgroundUpdateMessages
            return json(["session": detail])
        }
        if UITestFixtureEnvironment.hasLongBodies {
            var detail = session(id: sessionID, title: sessionTitle)
            detail["messages"] = longBodyMessages
            return json(["session": detail])
        }
        if UITestFixtureEnvironment.hasLongPrompt {
            var detail = session(id: sessionID, title: sessionTitle)
            detail["messages"] = longPromptMessages
            return json(["session": detail])
        }
        if UITestFixtureEnvironment.hasDiffBlocks {
            var detail = session(id: sessionID, title: sessionTitle)
            detail["messages"] = diffBlockMessages
            return json(["session": detail])
        }
        if UITestFixtureEnvironment.hasTranscriptMedia {
            var detail = session(id: sessionID, title: sessionTitle)
            detail["messages"] = transcriptMediaMessages
            return json(["session": detail])
        }
        var messages: [[String: Any]] = (0..<48).map { index in
            [
                "role": index.isMultiple(of: 2) ? "user" : "assistant",
                "content": "Fixture message \(index + 1) contains deterministic transcript content for scrolling.",
                "_ts": 2_000_000_000 + index
            ]
        }
        messages.append(contentsOf: linkInteractionMessages)
        var detail = session(id: sessionID, title: sessionTitle)
        detail["messages"] = messages
        return json(["session": detail])
    }

    /// The fixture chat, branched from the list's "Fixture Session 01", or that parent, which links nowhere (TAL-454).
    private static func branchedSessionResponse(_ url: URL) -> Data {
        let parentID = "ui-fixture-session-1"
        let requested = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "session_id" }?.value
        let isParent = requested == parentID
        var detail = session(id: isParent ? parentID : sessionID, title: isParent ? "Fixture Session 01" : sessionTitle)
        let text = isParent ? "Parent fixture" : "Branched fixture"
        detail["messages"] = [
            ["role": "user", "content": "\(text) prompt", "message_id": "\(text) prompt", "_ts": 2_000_000_000],
            ["role": "assistant", "content": "\(text) reply", "message_id": "\(text) reply", "_ts": 2_000_000_001]
        ]
        detail["branched_from"] = isParent ? NSNull() : ["session_id": parentID, "title": "Fixture Session 01"]
        return json(["session": detail])
    }

    static let backgroundResultText = "The repo has three packages."
    private static let backgroundDismissed = OSAllocatedUnfairLock(initialState: false)
    private static let newSessionID = "ui-fixture-new-session"

    /// TAL-372: a running delegation and a finished `/background` task the server pins, until the task is dismissed.
    private static func backgroundTasks() -> [[String: Any]] {
        let dismissed = backgroundDismissed.withLock { $0 }
        return [
            ["task_id": "deleg-ui-1", "kind": "delegation", "status": "running", "title": "Fix CI", "started_at": 2_000_000_010, "updated_at": 2_000_000_011, "completed_at": NSNull(),
             "result_available": false, "child_session_id": NSNull(), "exit_code": NSNull(), "agents": NSNull(), "pinned": true, "dismissible": false, "active": true],
            ["task_id": "bg-ui", "kind": "background_command", "status": "completed", "title": "Summarize the repo", "started_at": 2_000_000_012, "updated_at": 2_000_000_013, "completed_at": 2_000_000_013,
             "result_available": true, "child_session_id": NSNull(), "exit_code": NSNull(), "agents": NSNull(), "pinned": !dismissed, "dismissible": !dismissed, "active": false]
        ]
    }

    /// A typed marker the user sent, a batched wakeup with its reply, and a wakeup whose reply was a silence marker, as
    /// the server marks them (TAL-371, TAL-460). TAL-372: a delegation row that shows its subagents' progress in place.
    private static let backgroundUpdateMessages: [[String: Any]] = [
        ["role": "user", "content": "Split the audit", "message_id": "split-user", "_ts": 1_999_999_990, "_turn_id": "split"],
        [
            "role": "assistant", "content": "Started three subagents.", "message_id": "split-reply", "_ts": 1_999_999_991, "_turn_id": "split",
            "_anchor_activity_scene": [
                "version": "activity_scene_v1", "final_answer": "Started three subagents.",
                "activity_rows": [[
                    "row_id": "tool:split-call", "order_index": 0, "role": "tool",
                    "tool": ["id": "split-call", "name": "delegate_task", "kind": "delegate", "target": "", "args": [:], "preview": NSNull(), "result": NSNull(),
                             "done": true, "is_error": false, "duration": NSNull(), "cost_usd": NSNull(),
                             "background": ["task_ids": ["split-1", "split-2"], "status": "completed", "agents": ["total": 3, "completed": 2, "failed": 1, "running": 0]]]
                ]]
            ]
        ],
        ["role": "user", "content": "[ASYNC DELEGATION BATCH COMPLETE — typed] I typed this", "message_id": "typed-marker-user", "_ts": 2_000_000_000],
        ["role": "assistant", "content": "Noted.", "message_id": "typed-marker-reply", "_ts": 2_000_000_001],
        [
            "role": "user", "content": "[ASYNC DELEGATION BATCH COMPLETE — deleg_ui]\nDelegated result body.\n\n[IMPORTANT: Background process proc_ui completed (exit_code=1).]",
            "message_id": "wakeup-user", "_ts": 2_000_000_002, "_turn_id": "wake-ui",
            "_background_update": ["kind": "mixed", "attention": true, "count": 2, "summary": "ASYNC DELEGATION BATCH COMPLETE — deleg_ui", "lines": [
                ["kind": "agent", "status": "completed", "label": "Audit the fixture"],
                ["kind": "command", "status": "failed", "label": "make test", "exit_code": 1]
            ]]
        ],
        ["role": "assistant", "content": "The audit finished and the test run failed.", "message_id": "wakeup-reply", "_ts": 2_000_000_003, "_turn_id": "wake-ui", "_background_reply": true],
        [
            "role": "user", "content": "[IMPORTANT: Background process proc_quiet completed (exit_code=0).]",
            "message_id": "wakeup-quiet-user", "_ts": 2_000_000_004, "_turn_id": "wake-quiet",
            "_background_update": ["kind": "process", "attention": false, "count": 1, "summary": "IMPORTANT: Background process proc_quiet completed (exit_code=0).", "lines": [
                ["kind": "command", "status": "completed", "label": "./backup.sh", "exit_code": 0]
            ]]
        ],
        ["role": "assistant", "content": "[SILENT]", "message_id": "wakeup-quiet-reply", "_ts": 2_000_000_005, "_turn_id": "wake-quiet", "_background_reply": true, "_background_silent": true]
    ]

    /// 25 user bodies of 20-100K characters, each with a link, between short replies, collapsed
    /// the way the server ships them (TAL-456): the excerpt is a prefix and `content` stays whole.
    private static let longBodyMessages: [[String: Any]] = (0..<50).map { index in
        guard index.isMultiple(of: 2) else {
            return ["role": "assistant", "content": "Short reply \(index / 2 + 1).", "message_id": "long-body-reply-\(index)", "_ts": 2_000_000_000 + index]
        }
        let line = "Delegated result line with details at https://example.test/long/\(index).\n"
        let length = index == 48 ? 100_000 : 20_000 + index * 600
        let content = "Long fixture body \(index / 2 + 1)\n" + String(repeating: line, count: length / line.count)
        return [
            "role": "user", "content": content, "message_id": "long-body-user-\(index)", "_ts": 2_000_000_000 + index,
            "_display_truncated": true, "_display_excerpt": String(content.prefix(2_900))
        ]
    }

    /// A `diff` and a `patch` block whose lines are tinted by prefix, and `log` and `text` blocks with
    /// the same prefixes that stay plain (TAL-447).
    private static let diffBlockMessages: [[String: Any]] = [
        ["role": "user", "content": "Show the change.", "message_id": "diff-blocks-user", "_ts": 2_000_000_000],
        [
            "role": "assistant",
            "content": """
            ```diff
            diff --git a/Fixture.swift b/Fixture.swift
            index 83db48f..bf269f4 100644
            --- a/Fixture.swift
            +++ b/Fixture.swift
            @@ -1,2 +1,3 @@ struct Fixture {
             let unchanged = true
            -let fixtureRemoved = 1
            +let fixtureAdded = 2
            +
            ```

            ```patch
            @@ -4 +4 @@
            -patch fixture removed
            +patch fixture added
            ```

            ```log
            +log fixture line
            -log fixture line
            ```

            ```text
            +text fixture line
            ```
            """,
            "message_id": "diff-blocks-reply", "_ts": 2_000_000_001
        ]
    ]

    /// A 24-line pasted prompt the server folds (TAL-452), between short replies.
    private static let longPromptMessages: [[String: Any]] = [
        ["role": "user", "content": "Short opening question.", "message_id": "long-prompt-opening", "_ts": 2_000_000_000],
        ["role": "assistant", "content": "Short opening reply.", "message_id": "long-prompt-opening-reply", "_ts": 2_000_000_001],
        [
            "role": "user", "content": (1...24).map { "Fixture prompt line \($0)" }.joined(separator: "\n"),
            "message_id": "long-prompt-user", "_ts": 2_000_000_002, "_collapsible": true
        ],
        ["role": "assistant", "content": "Read the whole prompt.", "message_id": "long-prompt-reply", "_ts": 2_000_000_003]
    ]

    /// Mixed text-and-link content that pins deterministic long-press targets for
    /// the message-action interaction tests (TAL-49).
    /// TAL-186: a reply with images inside bold text, a list item, a quote and a link, and an audio file, in the
    /// server's shape: `content` as written, and `_display_content`, `_media` and the scene's display fields
    /// rewritten to `/api/media` URLs. Every image URL serves `transcriptMediaImage`.
    private static var transcriptMediaMessages: [[String: Any]] {
        let chart = "./api/media?path=%2Ffixture%2Fout%2Fchart.png&session_id=\(sessionID)"
        let audio = "./api/media?path=%2Ffixture%2Fout%2Fnarration.mp3&session_id=\(sessionID)"
        let content = """
        Here is the run:

        - MEDIA:/fixture/out/chart.png
        - **Before ![Chart](/fixture/out/chart.png) after**
        - Narration: MEDIA:/fixture/out/narration.mp3

        > MEDIA:/fixture/out/chart.png

        [![Linked chart](/fixture/out/chart.png)](https://example.invalid/chart)
        """
        let display = """
        Here is the run:

        - ![chart.png](\(chart))
        - **Before ![Chart](\(chart)) after**
        - Narration: [narration.mp3](\(audio))

        > ![chart.png](\(chart))

        [![Linked chart](\(chart))](https://example.invalid/chart)
        """
        let media: [[String: Any]] = [
            ["url": chart, "name": "chart.png", "mime": "image/png", "kind": "image"],
            ["url": audio, "name": "narration.mp3", "mime": "audio/mpeg", "kind": "audio"]
        ]
        return [
            ["role": "user", "content": "Plot the run", "message_id": "ui-fixture-media-user", "_turn_id": "media-turn", "_ts": 2_000_000_300],
            [
                "role": "assistant", "content": content, "message_id": "ui-fixture-media-reply", "_turn_id": "media-turn", "_ts": 2_000_000_301,
                "_display_content": display, "_media": media,
                "_anchor_activity_scene": [
                    "version": "activity_scene_v1", "final_answer": content, "final_answer_display": display, "final_answer_media": media,
                    "terminal_state": "completed",
                    "activity_rows": [["row_id": "media-thinking", "order_index": 0, "role": "reasoning", "text": "Plot the run.", "titles": ["Plotting"]]]
                ] as [String: Any]
            ]
        ]
    }

    private static let transcriptMediaImage: Data = UIGraphicsImageRenderer(size: CGSize(width: 240, height: 140)).pngData { context in
        UIColor.systemTeal.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 240, height: 140))
        UIColor.systemIndigo.setFill()
        for bar in 0..<6 {
            let height = CGFloat(30 + bar * 16)
            context.fill(CGRect(x: CGFloat(20 + bar * 36), y: 140 - height - 10, width: 24, height: height))
        }
    }

    /// Half a second of 8 kHz mono silence as WAV, which plays wherever the file is named `.mp3`.
    private static let transcriptMediaAudio: Data = {
        let samples = 4_000
        var data = Data("RIFF".utf8)
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        append(UInt32(36 + samples * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16)); append(UInt16(1)); append(UInt16(1)); append(UInt32(8_000)); append(UInt32(16_000)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        append(UInt32(samples * 2))
        data.append(Data(count: samples * 2))
        return data
    }()

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
                + "[FixtureLinkTarget](https://example.invalid/fixture-link) FixturePlainTail"
                + "\n\n## Lead [HeadingLink](https://example.invalid/heading-link)",
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
                                "is_error": false,
                                // TAL-331: a limited response clipped this result; `/api/session/tool-result` has it whole.
                                "result_truncated": true,
                                "result_chars": 26
                            ]
                        ],
                        // Prose on both sides keeps the edit its own row, not a group with the tool before it.
                        ["row_id": "prose-3", "order_index": 4, "role": "prose", "text": "Fixture edit."],
                        [
                            "row_id": "tool:ui-fixture-edit",
                            "order_index": 5,
                            "role": "tool",
                            "tool": [
                                "id": "ui-fixture-edit",
                                "name": "patch",
                                "kind": "write",
                                "target": "src/app.ts",
                                "preview": "{\"success\": true}",
                                "result": "{\"success\": true}",
                                "done": true,
                                "is_error": false,
                                // TAL-448: the server's counts cover the whole diff; the shown diff was cut.
                                "edit_diff": [
                                    "added": 2,
                                    "removed": 1,
                                    "diff": "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n import { run } from './run'\n-run(1)\n+run(2)\n+run(3)",
                                    "truncated": true,
                                    // TAL-604: that diff as the server parses it.
                                    "hunks": [[
                                        "header": "@@ -1,3 +1,4 @@", "old_start": 1, "new_start": 1, "new_end": 4,
                                        "additions": 2, "deletions": 1,
                                        "lines": [
                                            ["kind": "context", "old_line": 1, "new_line": 1, "text": " import { run } from './run'"],
                                            ["kind": "deletion", "old_line": 2, "new_line": NSNull(), "text": "-run(1)"],
                                            ["kind": "addition", "old_line": NSNull(), "new_line": 2, "text": "+run(2)"],
                                            ["kind": "addition", "old_line": NSNull(), "new_line": 3, "text": "+run(3)"]
                                        ]
                                    ]]
                                ]
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

    static func session(id: String, title: String) -> [String: Any] {
        [
            "session_id": id,
            "title": title,
            "message_count": 48,
            "last_message_at": 2_000_000_000,
            "sort_ts": 2_000_000_000,
            "workspace": "/fixture",
            "workspace_name": "Fixture Workspace",
            "model": "fixture-model",
            "model_provider": "fixture-provider",
            "profile": "fixture-profile",
            "archived": false,
            // Every row action gate the server ships (TAL-723); a row without one offers nothing.
            "can_pin": true,
            "can_archive": true,
            "can_delete": true,
            "can_duplicate": true,
            "can_branch": true,
            "enabled_toolsets": sessionToolsets.withLock { $0 }.map { $0 as Any } ?? NSNull()
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

    /// TAL-388: one pinned slot, one saved model the catalog no longer lists, and the rest on Auto.
    private static func auxiliaryModelsResponse() -> [String: Any] {
        let slots: [(String, String, String)] = [
            ("vision", "Vision", "image/screenshot analysis"), ("web_extract", "Web extract", "web page summarization"),
            ("compression", "Compression", "context summarization"), ("approval", "Approval", "smart command approval"),
            ("mcp", "MCP", "MCP tool reasoning"), ("title_generation", "Title generation", "session titles"),
            ("skills_hub", "Skills hub", "skills search/install"), ("curator", "Curator", "skill-usage review pass"),
            ("kanban_decomposer", "Kanban decomposer", "task decomposition"), ("profile_describer", "Profile describer", "profile summaries"),
            ("triage_specifier", "Triage specifier", "issue/task triage specs"),
        ]
        let tasks: [[String: Any]] = slots.map { task, label, description in
            var row: [String: Any] = [
                "task": task, "label": label, "description": description, "provider": "auto", "model": "",
                "is_auto": true, "value_label": "Fixture Model", "provider_label": "Fixture Provider",
                "selected_option_id": NSNull(), "in_catalog": true,
            ]
            if task == "title_generation" {
                row.merge(["provider": "fixture-provider", "model": "fixture-model", "is_auto": false, "selected_option_id": "fixture-model"]) { $1 }
            } else if task == "vision" {
                row.merge(["provider": "openrouter", "model": "legacy/vision-model", "is_auto": false, "value_label": "legacy/vision-model", "provider_label": "OpenRouter", "in_catalog": false]) { $1 }
            }
            return row
        }
        return ["main": ["provider": "fixture-provider", "model": "fixture-model"], "tasks": tasks]
    }

    static func json(_ object: Any) -> Data {
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
            let steps: [[String: Any]] = scenario == .batchClarification ? [
                ["qid": "q0", "question": "What sounds best for a quiet evening?", "choices": ["A movie", "A book", "A game", "Some music"], "multi_select": false],
                ["qid": "q1", "question": "Which drinks?", "choices": ["Tea", "Water"], "multi_select": true]
            ] : [
                ["qid": "q0", "question": "Which answer should continue?", "choices": ["Use the deterministic path"], "multi_select": false]
            ]
            send(events: [("clarify", [
                "clarify_id": "ui-fixture-draft-clarify",
                "session_id": Self.sessionID,
                "steps": steps
            ])])
            wait { $0.clarificationWasAnswered }
            guard !isStopped else { return }
            Self.chatState.settle()
            let answers = Self.chatState.receivedClarificationAnswers()
            var answer = answers["q0"] as? String ?? ""
            if scenario == .batchClarification {
                answer += " | " + (answers["q1"] as? [String] ?? []).joined(separator: ", ")
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
                    "session_id": Self.sessionID,
                    "steps": [["qid": "q0", "question": "Which deterministic path should continue?", "choices": ["Use the deterministic path"], "multi_select": false]]
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
        case .pendingSteers:
            send(events: [
                ("token", ["text": "Working on the backup."]),
                ("steer_pending", [
                    "steer_id": Self.pendingSteerID,
                    "text": Self.pendingSteerText,
                    "submitted_at": 2_000_000_050,
                    "state": "pending",
                    "actions": ["edit": true, "cancel": true, "send_now": true]
                ]),
                // The server offers no Send now for this one, so the App shows none.
                ("steer_pending", [
                    "steer_id": "steer-ui-fixture-web-2",
                    "text": "Skip the cache",
                    "submitted_at": 2_000_000_051,
                    "state": "pending",
                    "actions": ["edit": true, "cancel": true, "send_now": false]
                ])
            ])
            wait { $0.steerWithdrawnID != nil || $0.wasCancelled }
            guard !isStopped else { return }
            if let steerID = Self.chatState.steerWithdrawnIDSnapshot() {
                send(events: [("steer_withdrawn", ["steer_id": steerID, "reason": "edit", "text": Self.pendingSteerText])])
            }
            wait { $0.wasCancelled }
            guard !isStopped else { return }
            send(events: [("cancel", [:])])
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
        Self.chatState.wait(until: predicate, stopped: { [weak self] in self?.isStopped != false }) { [weak self] in
            guard let self, !self.isStopped else { return }
            self.client?.urlProtocol(self, didLoad: Data(": fixture heartbeat\n\n".utf8))
        }
    }

    var isStopped: Bool {
        lifecycleLock.withLock { stopped } || startedGeneration != Self.generation.withLock { $0 }
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
