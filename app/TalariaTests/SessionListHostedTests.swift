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
        first.isHidden = true

        FixtureLaunchArguments.scenario.append(UITestFixtureEnvironment.holdSessionListArgument)
        let relaunched = try hostWindow(fixture.sessionList())
        let painted = await awaitElement(in: relaunched, where: isFixtureRow)
        XCTAssertNotNil(painted, "The relaunch did not show the last chats before /api/sessions answered")
        fixture.releaseHeldLoads()
    }

    /// Reopening a chat paints its cached transcript and shows "Syncing messages" until the server answers, and no
    /// stream status competes with it (TAL-436).
    func testReopenedChatShowsSyncingUntilTheServerAnswers() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads"], for: self)
        let session = try await fixture.session()
        let first = try hostWindow(fixture.chat(session))
        let loaded = await awaitElement(in: first) { $0.accessibilityLabel?.hasPrefix("Fixture message 1 ") == true }
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

    func testFirstSendKeepsImportedFilesDurableUntilTheServerAccepts() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: true)
    }

    func testFirstSendWaitsForEveryImportedFileBeforePosting() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: true, partialImportFailure: true)
    }

    private func assertFirstSendDuringCreation(withImportedFile: Bool, partialImportFailure: Bool = false) async throws {
        var scenario = withImportedFile ? ["--ui-test-hold-chat-start"] : []
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
        try await typeIntoComposer("First pending prompt", in: window)
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertFalse(send.accessibilityTraits.contains(.notEnabled), "Send must accept local intent during creation")
        HostedAccessibility.activate(send)
        let consumed = await awaitCondition { window.firstView(ofType: UITextView.self)?.text == "" }
        XCTAssertTrue(consumed, "The submitted draft must clear while creation is held")
        attachHostedScreenshot(window, name: "first-send-pending-phone")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == "First pending prompt" }.count, 1)
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
            let restored = await awaitCondition { window.firstView(ofType: UITextView.self)?.text == "First pending prompt" }
            XCTAssertTrue(restored)
            attachHostedScreenshot(window, name: "mixed-import-blocked-phone")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Retry"))
            _ = try await requireElement(in: window, label: "Select model")
            XCTAssertEqual(creationCount, 1, "Retrying imports must reuse the created session")
            XCTAssertEqual(UITestFixtureURLProtocol.initialUploadAttemptCount, 3, "Only the failed import should retry")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Send"))
        }
        if withImportedFile {
            let posted = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
            XCTAssertTrue(posted)
            let held = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
            XCTAssertEqual(held?.text, "First pending prompt")
            XCTAssertEqual(held?.attachments.count, filenames.count, "The submitted files must remain durable until startChat answers")
            XCTAssertNotNil(held?.attachments.first?.file)
            if partialImportFailure {
                let request = try XCTUnwrap(UITestFixtureHold.shared.pendingRequests.last)
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual((body["attachments"] as? [[String: Any]])?.count, 2)
                XCTAssertEqual(Set((body["attachments"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }), Set(filenames))
            }
            fixture.releaseHeldLoads()
        }
        _ = try await requireElement(in: window, label: "Select model")
    }

    func testFailedFirstSendPreservesNewTypingAndRepeatedRetryJoinsCreation() async throws {
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
        try await sendFromComposer("Submitted prompt", in: window)
        let pending = await awaitElement(in: window, label: "Submitted prompt")
        XCTAssertNotNil(pending)
        try await typeIntoComposer("Newer draft", in: window)
        let heldDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
        XCTAssertEqual(heldDraft?.text, "Newer draft\n\nSubmitted prompt", "Both drafts must stay durable while creation is unresolved")
        creation?.resume(returning: .failed("Synthetic refusal"))
        creation = nil
        let retry = try await requireElement(in: window, label: "Retry")
        let restored = await awaitCondition { window.firstView(ofType: UITextView.self)?.text == "Newer draft\n\nSubmitted prompt" }
        XCTAssertTrue(restored)
        HostedAccessibility.activate(retry)
        HostedAccessibility.activate(retry)
        let retried = await awaitCondition { creation != nil }
        XCTAssertTrue(retried)
        XCTAssertEqual(creationCount, 2, "Repeated Retry must join the one replacement creation")
        creation?.resume(returning: .started(session))
        creation = nil
        _ = try await requireElement(in: window, label: "Select model")
        XCTAssertEqual(window.firstView(ofType: UITextView.self)?.text, "Newer draft\n\nSubmitted prompt")
    }

    func testLeavingAnUncreatedChatFencesLateAdoptionAndDraftMigration() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationReturned = false
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
        ).environment(\.scenePhase, .active).modelContainer(fixture.cache))
        defer { creation?.resume(returning: .failed("Test ended")) }
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        window.rootViewController = UIHostingController(rootView: Color.clear)
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
