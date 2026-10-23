import SwiftData
import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The Chats list and a reopened chat, hosted in process against the UI fixture (TAL-856): the row actions and the
/// selection bar a user reaches, and what a reopen or relaunch paints from the offline cache before the server answers.
/// The row swipe that reveals Archive is a system gesture; the phone check covers it (`app/docs/phone-checks.md`).
@MainActor
final class SessionListHostedTests: XCTestCase {
    private let sessionTitle = UITestFixtureURLProtocol.sessionTitle

    private func isFixtureRow(_ element: NSObject) -> Bool {
        element.accessibilityLabel?.hasPrefix(sessionTitle) == true
    }

    func testPendingPinIsVisibleBeforeTheServerAnswers() async throws {
        let arrived = expectation(description: "pin request held")
        let state = HeldRowMutationProtocol.State()
        HeldRowMutationProtocol.state = state
        state.onPin = { arrived.fulfill() }
        defer { HeldRowMutationProtocol.state = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldRowMutationProtocol.self]
        let server = URL(string: "https://pending-row.test")!
        let viewModel = SessionListViewModel(server: server, client: APIClient(baseURL: server, session: URLSession(configuration: configuration)))
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let actions = SessionListRowActions(retryLoad: {}, open: { _ in }, togglePinned: { _ in }, archive: { _ in }, delete: { _ in }, rename: { _ in }, duplicate: { _ in }, move: { _, _ in }, createProject: { _ in }, refreshProjects: {}, export: { _, _ in })
        let window = try hostWindow(SessionInteractiveRow(viewModel: viewModel, session: session, showsMessageCount: false, showsWorkspace: false, selectedSessionID: nil, actions: actions))
        let before = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        before.name = "pending-pin-before"
        before.lifetime = .keepAlways
        add(before)
        let pin = Task { await viewModel.setPinned(true, for: session) }
        await fulfillment(of: [arrived], timeout: 5)
        let pending = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Pending: Pin") == true }
        XCTAssertNotNil(pending, "The row must display the submitted pin while the write is unresolved")
        let after = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        after.name = "pending-pin-after"
        after.lifetime = .keepAlways
        add(after)
        XCTAssertNotEqual(viewModel.sessions.first?.pinned, true, "The pending pin must not change canonical grouping")
        state.answerPin()
        _ = await pin.value
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel?.contains("Pending: Pin") == true }
        XCTAssertTrue(cleared)
    }

    /// Archiving a chat removes it and offers Undo, which restores it from the server (TAL-443).
    func testUndoRestoresAnArchivedChat() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-archive-undo"], for: self)
        let window = try hostWindow(fixture.sessionList())
        let rowFound = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(rowFound, "Missing deterministic session fixture")
        let archive = try XCTUnwrap(
            row.accessibilityCustomActions?.first { $0.name == "Archive" },
            "The row offers no Archive action"
        )
        XCTAssertTrue(archive.actionHandler?(archive) ?? false, "Archive did not run")

        _ = try await requireElement(in: window, label: "Chat archived", "Archiving did not offer Undo")
        let archived = await awaitNoElement(in: window, timeout: 3, where: isFixtureRow)
        XCTAssertTrue(archived, "The archived chat stayed in the list")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Undo"))
        let restored = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(restored, "Undo did not restore the chat")
        let toastGone = await awaitNoElement(in: window, timeout: 5) { $0.accessibilityLabel == "Chat archived" }
        XCTAssertTrue(toastGone, "The toast stayed after Undo")
    }

    /// Select Chats picks rows, then one confirmed Delete removes them and ends the mode (TAL-627).
    func testSelectingChatsAndDeletingThemEndsSelectChats() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        let listed = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(listed, "Missing deterministic session fixture")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Select Chats"))
        for title in ["Fixture Session 01", "Fixture Session 02"] {
            let rowFound = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix(title) == true }
            HostedAccessibility.activate(try XCTUnwrap(rowFound, title))
        }
        _ = try await requireElement(in: window, label: "2 selected")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Delete"))
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented, "Delete asked for no confirmation")
        XCTAssertEqual(alert.title, "Delete 2 Chats?")
        XCTAssertTrue(HostedAccessibility.tap("Delete", in: alert), "The confirmation offers no Delete")

        let ended = await awaitNoElement(in: window) { $0.accessibilityLabel == "2 selected" }
        XCTAssertTrue(ended, "Select Chats kept its selection after every chat was deleted")
        let selectAgain = await awaitElement(in: window, label: "Select Chats")
        XCTAssertNotNil(selectAgain, "Select Chats did not end once every chat was deleted")
    }

    /// A relaunch paints the chats the App saw last time before `/api/sessions` answers (TAL-437): a second list on the
    /// first one's cache, with the server's answer held.
    func testRelaunchShowsTheLastChatsBeforeTheServerAnswers() async throws {
        let fixture = try FixtureApp(for: self)
        let first = try hostWindow(fixture.sessionList())
        let cached = await awaitElement(in: first, where: isFixtureRow)
        XCTAssertNotNil(cached, "Missing deterministic session fixture")
        attachHostedScreenshot(first, name: "session-cache-before-repeat-refresh")
        // Exercise the incremental writer and foreground cleanup in the real build before
        // reopening offline. Neither may lose the last server-selected rows or their order.
        let sessions = try await fixture.client.sessions().sessions ?? []
        try CacheStore.cacheSessions(sessions, serverURL: UITestFixtureEnvironment.serverURL,
            in: fixture.cache.mainContext)
        try CacheStore.maintainCache(in: fixture.cache.mainContext)
        first.isHidden = true

        FixtureLaunchArguments.scenario.append(UITestFixtureEnvironment.holdSessionListArgument)
        let relaunched = try hostWindow(fixture.sessionList())
        let painted = await awaitElement(in: relaunched, where: isFixtureRow)
        XCTAssertNotNil(painted, "The relaunch did not show the last chats before /api/sessions answered")
        attachHostedScreenshot(relaunched, name: "session-cache-after-repeat-refresh-offline")
        fixture.releaseHeldLoads()
    }

    /// Reopening a chat paints its cached transcript and shows "Syncing messages" until the server answers, and no
    /// stream status competes with it (TAL-436).
    func testReopenedChatShowsSyncingUntilTheServerAnswers() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads"], for: self)
        let session = try await fixture.session()
        let first = try hostWindow(fixture.chat(session))
        let loaded = await awaitElement(in: first, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertNotNil(loaded, "The chat's first load never answered")
        first.isHidden = true

        let reopened = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server", "The reopened chat never showed Syncing messages")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Hermes is checking the response stream"), "Checking stream competed with Syncing messages")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Hermes is reconnecting the response stream"), "Reconnecting stream competed with Syncing messages")

        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced, "Syncing messages stayed after the server answered")
    }

    func testReopenedToolHeavyChatPaintsItsCompleteRecentWindowWhileDetailIsHeld() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdTranscriptReloadsArgument], for: self)
        let session = try await fixture.session()
        // Consume the fixture's first detail; every subsequent detail stays held until release.
        _ = try await fixture.client.session(id: UITestFixtureURLProtocol.sessionID)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let body = try ChatViewModelSendTests.toolHeavyRecentSessionJSON()
        let detail = try XCTUnwrap(decoder.decode(SessionResponse.self, from: Data(body.utf8)).session)
        // The legacy cache exercises the old raw-row crop in the same real build.
        try CacheStore.cacheMessages(
            detail.messages ?? [], serverURL: UITestFixtureEnvironment.serverURL,
            sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext
        )
        let legacyWindow = try CacheStore.cachedTranscriptWindow(
            serverURL: UITestFixtureEnvironment.serverURL, sessionID: UITestFixtureURLProtocol.sessionID,
            in: fixture.cache.mainContext
        )
        XCTAssertEqual(legacyWindow.messages, Array((detail.messages ?? []).suffix(50)))
        XCTAssertEqual(legacyWindow.messagesOffset, 0)
        XCTAssertNil(legacyWindow.recentMessagesOffset)
        let legacy = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: legacy, label: "Syncing messages with the server")
        _ = try await requireElement(in: legacy, label: "Recent answer 24")
        attachHostedScreenshot(legacy, name: "legacy-cache-before-sync-phone")
        legacy.isHidden = true
        legacy.rootViewController = nil

        try CacheStore.cacheMessages(
            detail.messages ?? [], serverURL: UITestFixtureEnvironment.serverURL,
            sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext,
            messagesOffset: detail.messagesOffset, hasOlderMessages: detail.messagesTruncated == true
        )
        let recentWindow = try CacheStore.cachedTranscriptWindow(
            serverURL: UITestFixtureEnvironment.serverURL, sessionID: UITestFixtureURLProtocol.sessionID,
            in: fixture.cache.mainContext
        )
        XCTAssertEqual(recentWindow.messages, detail.messages)
        XCTAssertEqual(recentWindow.messagesOffset, 200)
        XCTAssertEqual(recentWindow.recentMessagesOffset, 200)
        XCTAssertTrue(recentWindow.hasOlderMessages)
        let reopened = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server")
        _ = try await requireElement(in: reopened, label: "Recent answer 24")
        let observer = try XCTUnwrap(reopened.firstView(ofType: ChatScrollObserver.ObserverView.self))
        let position = try XCTUnwrap(observer.coordinator?.scrollPositionController)
        var ancestor = observer.superview
        while ancestor != nil, !(ancestor is UIScrollView) { ancestor = ancestor?.superview }
        let recentScroll = try XCTUnwrap(ancestor as? UIScrollView)
        let settled = await awaitCondition { !position.isPreservingPosition }
        XCTAssertTrue(settled)
        position.onHoldAnchor?(ChatTranscriptView.containerID(for: "transcript:200"), .top)
        let oldestIsVisible = await awaitCondition {
            guard let question = HostedAccessibility.element(in: reopened, label: "Recent question 0") else { return false }
            return question.accessibilityFrame.intersects(recentScroll.convert(recentScroll.bounds, to: nil))
        }
        XCTAssertTrue(oldestIsVisible, "The first server row must remain reachable in the cached window before reconciliation")
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server")
        attachHostedScreenshot(reopened, name: "recent-window-before-sync-phone")
        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced)
    }

    /// A server that reports the Agent's `state.db` as corrupt gets one notice above the Chats list that VoiceOver
    /// reads with the server's reason (TAL-830).
    func testChatsListShowsTheServersCorruptAgentStorageNotice() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.corruptAgentStorageArgument], for: self)
        let window = try hostWindow(fixture.sessionList())

        let found = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix("Agent session storage is damaged") == true }
        let notice = try XCTUnwrap(found, "No storage notice. Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertTrue(
            notice.accessibilityLabel?.contains(UITestFixtureEnvironment.corruptAgentStorageReason) == true,
            "VoiceOver does not read the server's reason: \(notice.accessibilityLabel ?? "nil")"
        )
        XCTAssertEqual(HostedAccessibility.elements(in: window, labelContaining: "Agent session storage").count, 1)
    }

    /// Healthy storage shows no notice (TAL-830).
    func testChatsListShowsNoStorageNoticeWhenTheServerReportsOK() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        let listed = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(listed, "Missing deterministic session fixture")

        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Agent session").isEmpty)
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "hermes-agent").isEmpty)
    }

    /// Each degraded state reads its own notice with the server's reason, and `ok` or no state shows none (TAL-830).
    func testAgentStorageBannerReadsEachDegradedState() throws {
        let notices: [(AgentStorage.State, String)] = [
            (.corrupt, "Agent session storage is damaged"),
            (.unavailable, "Agent sessions could not be read"),
            (.outdated, "Upgrade hermes-agent to list sessions"),
        ]
        for (state, title) in notices {
            let window = try hostWindow(AgentStorageBanner(storage: AgentStorage(state: state, reason: "Synthetic reason")))
            let labels = HostedAccessibility.labels(in: window)
            XCTAssertEqual(labels.count, 1, "\(state): \(labels)")
            XCTAssertTrue(labels.first?.hasPrefix(title) == true, "\(state): \(labels)")
            XCTAssertTrue(labels.first?.contains("Synthetic reason") == true, "\(state): \(labels)")
        }
        for storage in [AgentStorage(state: .ok, reason: nil), nil] {
            let window = try hostWindow(AgentStorageBanner(storage: storage))
            XCTAssertEqual(HostedAccessibility.labels(in: window), [], "\(String(describing: storage))")
        }
    }

    /// A New Chat whose session fails to start says so in its composer, with Send off, and Retry starts it (TAL-636).
    func testNewChatReportsAFailedStartInItsComposerAndRetries() async throws {
        let fixture = try FixtureApp(["--ui-test-refuse-first-session-creation"], for: self)
        let window = try hostWindow(fixture.sessionList())
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))

        let retry = try await requireElement(in: window, label: "Retry", "The composer does not offer Retry after a failed start")
        let send = HostedAccessibility.element(in: window, label: "Send")
        XCTAssertTrue(send?.accessibilityTraits.contains(.notEnabled) ?? true, "Send is enabled before the chat started")
        HostedAccessibility.activate(retry)
        _ = try await requireElement(in: window, label: "Select model", "Retry did not start the chat")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Retry"))
    }

    func testUnconfirmedCreationDoesNotOfferNonIdempotentRetry() async throws {
        let fixture = try FixtureApp(["--ui-test-fail-first-session-creation"], for: self)
        let window = try hostWindow(fixture.sessionList())
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))
        let resolved = await awaitCondition {
            HostedAccessibility.elements(in: window).contains {
                $0.accessibilityLabel == "Retry" || $0.accessibilityLabel?.contains("Check Chats") == true
            }
        }
        XCTAssertTrue(resolved, "The creation result must have reached its failure strip")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Retry"), "A lost creation result cannot safely create another session")
    }

    func testFirstSendConsumesDraftAndShowsOneRowWhileCreationIsHeld() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: false)
    }

    /// TAL-1045: a chat New Chat started in Safe Mode takes on the server's created session: its header leads with the
    /// frozen mode, and its attached owner takes the first message.
    func testANewSafeModeChatShowsItsServerModeAndTakesInput() async throws {
        let fixture = try FixtureApp([], for: self)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let created = try decoder.decode(SessionResponse.self, from: Data(try executionModesFixture("created").utf8))
        let detail = try XCTUnwrap(created.session)
        let window = try hostWindow(NavigationStack {
            ChatView(
                session: SessionSummary(title: "New Chat"),
                server: UITestFixtureEnvironment.serverURL,
                onAPIError: { _ in },
                loadsInitialMessages: false,
                draftStore: fixture.environment.draftStore,
                startSession: { .started(SessionSummary(from: detail), detail: detail) }
            )
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))

        let header = await awaitElement(in: window) { ($0.accessibilityLabel ?? "").contains("Safe Mode") }
        XCTAssertNotNil(header, "The header shows the mode the server froze")
        let started = await awaitNoElement(in: window) { $0.accessibilityLabel == "Starting chat…" }
        XCTAssertTrue(started)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "This session is read-only."), "The attached owner takes input")
        settle(0.3)
        attachHostedScreenshot(window, name: "safe-mode-new-chat-phone")
    }

    func testFirstSendKeepsImportedFilesDurableUntilTheServerAccepts() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: true)
    }

    func testFirstSendWaitsForEveryImportedFileBeforePosting() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: true, partialImportFailure: true)
    }

    func testPendingSlashCommandWaitsForCreationBeforeStartingChat() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: false, pendingSlash: true)
    }

    private func assertFirstSendDuringCreation(withImportedFile: Bool, partialImportFailure: Bool = false, pendingSlash: Bool = false) async throws {
        let submittedDraft = pendingSlash ? "/queue hello" : "First pending prompt"
        let message = pendingSlash ? "hello" : submittedDraft
        var scenario = withImportedFile || pendingSlash ? ["--ui-test-hold-chat-start"] : []
        if partialImportFailure { scenario.append("--ui-test-fail-first-upload") }
        let fixture = try FixtureApp(scenario, for: self)
        let session = try await fixture.session()
        let filenames = partialImportFailure ? ["first-fails.txt", "later-succeeds.txt"] : (withImportedFile ? ["intent.txt"] : [])
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationCount = 0
        let window = try hostWindow(NavigationStack {
            ChatView(
                session: SessionSummary(title: "New Chat"),
                server: UITestFixtureEnvironment.serverURL,
                onAPIError: { _ in },
                initialAttachments: filenames.map {
                    SharedAttachmentImport(filename: $0, typeIdentifier: "public.plain-text", data: Data("Synthetic file".utf8))
                },
                loadsInitialMessages: false,
                draftStore: fixture.environment.draftStore,
                startSession: {
                    creationCount += 1
                    return await withCheckedContinuation { creation = $0 }
                }
            )
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
        defer { creation?.resume(returning: .failed("Test ended")) }
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        try await typeIntoComposer(submittedDraft, in: window)
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertFalse(send.accessibilityTraits.contains(.notEnabled), "Send must accept local intent during creation")
        HostedAccessibility.activate(send)
        if withImportedFile {
            window.endEditing(true)
            _ = try await requireElement(in: window, label: "Message")
        }
        let consumed = await awaitCondition { self.composerDraftText(in: window) == "" }
        XCTAssertTrue(consumed, "The submitted draft must clear while creation is held")
        attachHostedScreenshot(window, name: "first-send-pending-phone")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == message }.count, 1)
        if pendingSlash {
            let heldDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
            XCTAssertEqual(heldDraft?.text, submittedDraft, "A pending slash send must keep its raw draft until acceptance")
            guard heldDraft?.text == submittedDraft else { return }
            try await typeIntoComposer("Newer draft", in: window)
        }
        XCTAssertEqual(creationCount, 1)
        creation?.resume(returning: .started(session))
        creation = nil
        if partialImportFailure {
            let settled = await awaitCondition {
                UITestFixtureHold.shared.pendingCount > 0 || HostedAccessibility.element(in: window, label: "Retry") != nil
            }
            XCTAssertTrue(settled)
            XCTAssertEqual(UITestFixtureHold.shared.pendingCount, 0, "A failed import followed by a success must not post a partial first message")
            guard UITestFixtureHold.shared.pendingCount == 0 else {
                fixture.releaseHeldLoads()
                return
            }
            XCTAssertEqual(UITestFixtureURLProtocol.initialUploadAttemptCount, 2)
            let restored = await awaitCondition { self.composerDraftText(in: window) == "First pending prompt" }
            XCTAssertTrue(restored)
            attachHostedScreenshot(window, name: "mixed-import-blocked-phone")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Retry"))
            let retried = await awaitCondition { UITestFixtureURLProtocol.initialUploadAttemptCount == 3 }
            XCTAssertTrue(retried, "Retry must upload the retained failed initial file")
            guard retried else { return }
            _ = try await requireElement(in: window, label: "Select model")
            XCTAssertEqual(creationCount, 1, "Retrying imports must reuse the created session")
            XCTAssertEqual(UITestFixtureURLProtocol.initialUploadAttemptCount, 3, "Only the failed import should retry")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Send"))
        }
        if withImportedFile || pendingSlash {
            let posted = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
            XCTAssertTrue(posted)
            let held = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
            XCTAssertEqual(held?.text, pendingSlash ? "Newer draft\n\n\(submittedDraft)" : submittedDraft)
            XCTAssertEqual(held?.attachments.count, filenames.count, "The submitted files must remain durable until startChat answers")
            if withImportedFile { XCTAssertNotNil(held?.attachments.first?.file) }
            if pendingSlash {
                let request = try XCTUnwrap(UITestFixtureHold.shared.pendingRequests.last)
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual(body["message"] as? String, message)
                XCTAssertEqual(body["session_id"] as? String ?? body["sessionId"] as? String, session.sessionId)
                XCTAssertEqual(creationCount, 1)
            }
            if partialImportFailure {
                let request = try XCTUnwrap(UITestFixtureHold.shared.pendingRequests.last)
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual((body["attachments"] as? [[String: Any]])?.count, 2)
                XCTAssertEqual(Set((body["attachments"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }), Set(filenames))
            }
            fixture.releaseHeldLoads()
        }
        _ = try await requireElement(in: window, label: "Select model")
        if pendingSlash {
            let accepted = await awaitCondition {
                HostedAccessibility.element(in: window, label: "Send")?.accessibilityTraits.contains(.notEnabled) == false
            }
            XCTAssertTrue(accepted)
            let draft = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
            XCTAssertEqual(draft?.text, "Newer draft", "Acceptance must consume only the original slash draft")
            XCTAssertEqual(composerDraftText(in: window), "Newer draft")
        }
    }

    func testFailedFirstSendPreservesNewTypingAndRepeatedRetryJoinsCreation() async throws {
        try await assertFailedFirstSend(submittedDraft: "Submitted prompt", message: "Submitted prompt")
    }

    func testPendingSlashCommandSurvivesFailedSessionStartup() async throws {
        try await assertFailedFirstSend(submittedDraft: "/queue hello", message: "hello")
    }

    private func assertFailedFirstSend(submittedDraft: String, message: String) async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationCount = 0
        let window = try hostWindow(ChatView(
            session: SessionSummary(title: "New Chat"),
            server: UITestFixtureEnvironment.serverURL,
            onAPIError: { _ in },
            loadsInitialMessages: false,
            draftStore: fixture.environment.draftStore,
            startSession: {
                creationCount += 1
                return await withCheckedContinuation { creation = $0 }
            }
        ).environment(\.scenePhase, .active).modelContainer(fixture.cache))
        defer { creation?.resume(returning: .failed("Test ended")) }
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        try await sendFromComposer(submittedDraft, in: window)
        let consumed = await awaitCondition { self.composerDraftText(in: window) == "" }
        XCTAssertTrue(consumed)
        let durableDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
        XCTAssertEqual(durableDraft?.text, submittedDraft, "A pending send must stay durable until acceptance")
        guard durableDraft?.text == submittedDraft else { return }
        let pending = await awaitElement(in: window, label: message)
        XCTAssertNotNil(pending)
        try await typeIntoComposer("Newer draft", in: window)
        let heldDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
        XCTAssertEqual(heldDraft?.text, "Newer draft\n\n\(submittedDraft)", "Both drafts must stay durable while creation is unresolved")
        creation?.resume(returning: .failed("Synthetic refusal"))
        creation = nil
        let retry = try await requireElement(in: window, label: "Retry")
        let restored = await awaitCondition { self.composerDraftText(in: window) == "Newer draft\n\n\(submittedDraft)" }
        XCTAssertTrue(restored)
        HostedAccessibility.activate(retry)
        HostedAccessibility.activate(retry)
        let retried = await awaitCondition { creation != nil }
        XCTAssertTrue(retried)
        XCTAssertEqual(creationCount, 2, "Repeated Retry must join the one replacement creation")
        creation?.resume(returning: .started(session))
        creation = nil
        _ = try await requireElement(in: window, label: "Select model")
        XCTAssertEqual(composerDraftText(in: window), "Newer draft\n\n\(submittedDraft)")
    }

    func testLeavingAnUncreatedChatFencesLateAdoptionAndDraftMigration() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationReturned = false
        var didDisappear = false
        let window = try hostWindow(ChatView(
            session: SessionSummary(title: "New Chat"),
            server: UITestFixtureEnvironment.serverURL,
            onAPIError: { _ in },
            initialDraft: "Abandoned prompt",
            loadsInitialMessages: false,
            draftStore: fixture.environment.draftStore,
            startSession: {
                let result = await withCheckedContinuation { creation = $0 }
                XCTAssertTrue(Task.isCancelled, "Leaving the view must cancel its creation owner")
                creationReturned = true
                return result
            }
        ).environment(\.scenePhase, .active).modelContainer(fixture.cache)
            .onDisappear { didDisappear = true })
        defer { creation?.resume(returning: .failed("Test ended")) }
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        window.rootViewController = UIHostingController(rootView: Color.clear)
        // Hosting-controller replacement can defer SwiftUI's disappearance transaction.
        let disappeared = await awaitCondition { didDisappear }
        XCTAssertTrue(disappeared)
        guard disappeared else { return }
        let newKey = ChatDraftKey.newChat(server: UITestFixtureEnvironment.serverURL)
        fixture.environment.draftStore.setDraft("Replacement draft", for: newKey)
        creation?.resume(returning: .started(session))
        creation = nil
        let returned = await awaitCondition { creationReturned }
        XCTAssertTrue(returned)
        let migrated = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
        let current = await fixture.environment.draftStore.draft(for: newKey)
        XCTAssertNil(migrated, "A closed chat must not adopt a late session or move another chat's draft")
        XCTAssertEqual(current?.text, "Replacement draft")
    }

    func testAcceptedSendAfterLeavingConsumesOnlyItsOwnedDraft() async throws {
        for (newerTyping, replacementDraft, movesDraft) in [
            (nil as String?, nil as String?, false),
            ("Newer typing", nil, false),
            (nil, "Replacement draft", false),
            (nil, nil, true),
        ] {
            let fixture = try FixtureApp(["--ui-test-hold-chat-start"], for: self)
            let session = try await fixture.session()
            let server = UITestFixtureEnvironment.serverURL
            let defaultsName = "TAL1080.LateAcceptance.\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsName))
            defer { defaults.removePersistentDomain(forName: defaultsName) }
            let stream = SpySSEStreamingClient()
            let viewModel = ChatViewModel(
                session: session, server: server, client: fixture.client,
                streamClient: stream, approvalStreamClient: SpySSEStreamingClient(),
                clarifyStreamClient: SpySSEStreamingClient(), liveActivityManager: SpyChatLiveActivityManager(),
                listenAudioSession: SpyListenAudioSession(), userDefaults: defaults
            )
            var accepted = false
            let window = try hostWindow(NavigationStack {
                ChatView(
                    session: session, server: server, onAPIError: { _ in },
                    loadsInitialMessages: false, draftStore: fixture.environment.draftStore,
                    viewModel: viewModel, onConversationStarted: { accepted = true }
                )
            }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
            try await sendFromComposer("Submitted prompt", in: window)
            let posted = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
            XCTAssertTrue(posted)
            if let newerTyping { try await typeIntoComposer(newerTyping, in: window) }
            window.rootViewController = UIHostingController(rootView: Color.clear)
            // Deliver the same navigation cleanup explicitly before releasing the transport;
            // UIKit may defer the hosting controller's disappearance transaction.
            viewModel.suspendStreamForNavigation()
            let sessionKey = ChatDraftKey.session(server: server, session: session)
            let key = movesDraft ? ChatDraftKey.newChat(server: server) : sessionKey
            if movesDraft { fixture.environment.draftStore.moveDraft(from: sessionKey, to: key) }
            if let replacementDraft { fixture.environment.draftStore.setDraft(replacementDraft, for: key) }
            fixture.releaseHeldLoads()
            let finished = await awaitCondition { !viewModel.isStartingChat }
            XCTAssertTrue(finished)
            let draft = await fixture.environment.draftStore.draft(for: key)
            XCTAssertTrue(accepted, "The server-accepted send must settle even after its view leaves")
            XCTAssertEqual(draft?.text ?? "", replacementDraft ?? newerTyping ?? "", "An accepted prompt must not return as an unsent draft or clear newer input")
            XCTAssertNil(viewModel.activeStreamID)
            XCTAssertTrue(stream.startedURLs.isEmpty)
        }
    }
}


private final class HeldRowMutationProtocol: URLProtocol {
    final class State: @unchecked Sendable {
        var onPin: (() -> Void)?
        private let lock = NSLock()
        private var pin: HeldRowMutationProtocol?
        func hold(_ request: HeldRowMutationProtocol) {
            lock.lock(); pin = request; lock.unlock()
            onPin?()
        }
        func answerPin() {
            lock.lock(); let request = pin; pin = nil; lock.unlock()
            request?.answer(#"{"ok": true}"#)
        }
    }
    nonisolated(unsafe) static var state: State?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pending-row.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.path == "/api/session/pin" { Self.state?.hold(self) }
        else { answer(#"{"sessions":[{"session_id":"pending-row","title":"Pending fixture","pinned":false,"can_pin":true,"source_kind":"webui"}]}"#) }
    }
    override func stopLoading() {}
    func answer(_ json: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// TAL-1195: what the Chats list says about its saved rows when a reload fails. Only a failure that shows the device has
/// no network says Offline; one cut off by backgrounding, or a server that is down, says so instead, and the next answer
/// clears it.
extension SessionListHostedTests {
    func testAReloadCutOffByBackgroundingIsNotShownAsOffline() async throws {
        let fixture = try FixtureApp(for: self)
        let scene = HostedScenePhase()
        let window = try hostWindow(ScenePhasedSessionList(fixture: fixture, scene: scene))
        let listed = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(listed, "Missing deterministic session fixture")
        await awaitInitialLoad(scene)

        holdSessionList(true)
        try await openChat(row, in: window)
        try popToList(in: window)
        let reloading = await awaitHeldSessionList()
        XCTAssertTrue(reloading, "Returning to the list started no reload")

        // The reload is still in flight when the App leaves the foreground, and the suspended connection drops.
        scene.phase = .background
        settle()
        UITestFixtureURLProtocol.sessionListFailures.withLock { $0 = [.transport(.networkConnectionLost)] }
        fixture.releaseHeldLoads()
        let fellBack = await awaitElement(in: window, where: isCachedDataNotice)
        XCTAssertNotNil(fellBack, "The dropped reload did not fall back to the saved rows")

        scene.phase = .active
        let returned = await awaitHeldSessionList()
        XCTAssertTrue(returned, "Returning to the foreground started no list reload")
        let found = await awaitElement(in: window, where: isCachedDataNotice)
        let notice = try XCTUnwrap(found?.accessibilityLabel, "No saved-rows notice. Elements: \(HostedAccessibility.labels(in: window))")
        attachHostedScreenshot(window, name: "dropped-reload-on-return")
        XCTAssertFalse(notice.contains("Offline"), "A dropped connection is not a lost network: \(notice)")
        XCTAssertTrue(notice.hasPrefix("Reconnecting"), notice)
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isFixtureRow), "The saved rows left the list")
        XCTAssertEqual(isSelectChatsEnabled(in: window), false, "Saved rows must keep their action gates")

        holdSessionList(false)
        fixture.releaseHeldLoads()
        let live = await awaitCondition { self.isSelectChatsEnabled(in: window) == true }
        XCTAssertTrue(live, "The server's answer did not end the saved-rows mode")
    }

    func testReturningFromAChatWhileTheListReloadsMakesNoOfflineClaim() async throws {
        let fixture = try FixtureApp(for: self)
        let scene = HostedScenePhase()
        let window = try hostWindow(ScenePhasedSessionList(fixture: fixture, scene: scene))
        let listed = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(listed, "Missing deterministic session fixture")
        await awaitInitialLoad(scene)

        // A plain return: the reload is held, and a pending reload says nothing about the connection.
        holdSessionList(true)
        try await openChat(row, in: window)
        try popToList(in: window)
        let reloading = await awaitHeldSessionList()
        XCTAssertTrue(reloading, "Returning to the list started no reload")
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isFixtureRow), "The rows left during the reload")
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains(where: isCachedDataNotice), "\(HostedAccessibility.labels(in: window))")

        // That reload answers 503 while a chat covers the list; the return shows the server's state, not Offline.
        let reopened = await awaitElement(in: window, where: isFixtureRow)
        try await openChat(try XCTUnwrap(reopened), in: window)
        UITestFixtureURLProtocol.sessionListFailures.withLock { $0 = [.status(503)] }
        fixture.releaseHeldLoads()
        try popToList(in: window)
        let returned = await awaitHeldSessionList()
        XCTAssertTrue(returned, "Returning to the list started no reload")
        let found = await awaitElement(in: window, where: isCachedDataNotice)
        let notice = try XCTUnwrap(found?.accessibilityLabel, "No saved-rows notice. Elements: \(HostedAccessibility.labels(in: window))")
        attachHostedScreenshot(window, name: "server-unavailable-on-return")
        XCTAssertFalse(notice.contains("Offline"), "A 503 is not a lost network: \(notice)")
        XCTAssertTrue(notice.hasPrefix("Server unavailable"), notice)
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isFixtureRow), "The saved rows left the list")
        XCTAssertEqual(isSelectChatsEnabled(in: window), false, "Saved rows must keep their action gates")

        holdSessionList(false)
        fixture.releaseHeldLoads()
        let live = await awaitCondition { self.isSelectChatsEnabled(in: window) == true }
        XCTAssertTrue(live, "The server's answer did not end the saved-rows mode")
    }

    /// Each reason reads its own notice at phone width, and only a lost network says Offline.
    func testCachedDataBannerReadsEachReason() throws {
        let notices: [(CacheFallbackReason, String)] = [
            (.offline, "Offline - viewing cached version"),
            (.serverUnreachable, "Server unreachable - cached version"),
            (.serverUnavailable, "Server unavailable - cached version"),
            (.connectionInterrupted, "Reconnecting - cached version"),
        ]
        for (reason, title) in notices {
            let window = try hostWindow(CachedDataBanner(reason: reason).frame(width: HostedSize.phone.width).fixedSize(horizontal: false, vertical: true))
            XCTAssertEqual(HostedAccessibility.labels(in: window), [title], "\(reason)")
            attachHostedScreenshot(window, name: "cached-data-banner-\(reason)")
        }
    }

    /// Select Chats is off while the list shows saved rows. A removed list row can linger in the accessibility tree, so
    /// this live control, not the notice's absence, shows that the list is the server's again.
    private func isSelectChatsEnabled(in window: UIWindow) -> Bool? {
        HostedAccessibility.element(in: window, label: "Select Chats").map { !$0.accessibilityTraits.contains(.notEnabled) }
    }

    private func isCachedDataNotice(_ element: NSObject) -> Bool {
        element.accessibilityLabel?.contains("cached version") == true
    }

    private func holdSessionList(_ holds: Bool) {
        FixtureLaunchArguments.scenario.removeAll { $0 == UITestFixtureEnvironment.holdSessionListArgument }
        if holds { FixtureLaunchArguments.scenario.append(UITestFixtureEnvironment.holdSessionListArgument) }
    }

    private func awaitHeldSessionList(timeout: TimeInterval = 10) async -> Bool {
        await awaitCondition(timeout: timeout) {
            UITestFixtureHold.shared.pendingRequests.contains { $0.url?.path == "/api/sessions" }
        }
    }

    /// Returns to the foreground until the return reloads the list at once, which it does only once the list's first
    /// load has finished; before that, the restarted automatic refresh waits out its interval.
    private func awaitInitialLoad(_ scene: HostedScenePhase) async {
        func answeredLists() -> Int {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/sessions" }.count }
        }
        let deadline = Date().addingTimeInterval(35)
        while Date() < deadline {
            let answered = answeredLists()
            scene.phase = .inactive
            settle()
            scene.phase = .active
            if await awaitCondition(timeout: 1, { answeredLists() > answered }) { return }
        }
        XCTFail("The list's first load never finished")
    }

    private func openChat(_ row: NSObject, in window: UIWindow) async throws {
        XCTAssertTrue(HostedAccessibility.activate(row), "The row did not open")
        let opened = await awaitCondition { self.pushedNavigation(in: window) != nil }
        XCTAssertTrue(opened, "The chat did not open over the list")
    }

    private func popToList(in window: UIWindow) throws {
        let navigation = try XCTUnwrap(pushedNavigation(in: window), "No chat over the list")
        navigation.popToRootViewController(animated: false)
        settle()
    }

    private func pushedNavigation(in window: UIWindow) -> UINavigationController? {
        var pending = window.rootViewController.map { [$0] } ?? []
        while let controller = pending.popLast() {
            if let navigation = controller as? UINavigationController, navigation.viewControllers.count > 1 {
                return navigation
            }
            pending += controller.children
        }
        return nil
    }
}

/// The scene phase a hosted test moves, standing in for the App leaving the foreground and returning (TAL-1195).
@MainActor
@Observable
private final class HostedScenePhase {
    var phase: ScenePhase = .active
}

private struct ScenePhasedSessionList: View {
    let fixture: FixtureApp
    let scene: HostedScenePhase

    var body: some View {
        fixture.sessionList(scenePhase: scene.phase)
    }
}
