import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Opening or closing the iPhone Duo swaps the split view for a stack (TAL-1477). The open chat keeps its run and the
/// reader's place, and nothing about it is fetched again.
@MainActor
final class DuoFoldHostedTests: XCTestCase {
    private struct Folding {
        let fixture: FixtureApp
        let window: UIWindow
        let display: HostedDuoDisplay
        let inner: CGSize
    }

    /// What only the chat asks the server for. The Chats list and the app's own feeds are not the chat's, and the list
    /// reads `/api/profiles` itself, so the composer's reload shows as `/api/models`.
    private static let chatPaths: Set<String> = [
        "/api/session", "/api/chat/start", "/api/chat/stream", "/api/chat/stream/status", "/api/git-info",
        "/api/models", "/api/background/tasks",
    ]

    /// The fixture chat opened beside the Chats list on the Duo's inner display.
    private func openChatOnInnerDisplay(
        _ scenario: [String] = [],
        size inner: CGSize = HostedSize.duoInner,
        list: (FixtureApp) async throws -> AnyView = { AnyView($0.sessionList()) }
    ) async throws -> Folding {
        let fixture = try FixtureApp(scenario, for: self)
        let display = HostedDuoDisplay()
        let window = try hostWindow(FoldingDisplay(display: display, content: try await list(fixture)), size: inner) {
            $0.horizontalSizeClass = .regular
            $0.verticalSizeClass = .regular
        }
        try await openSidebar(in: window)
        let row = try await requireElement(in: window, "Missing deterministic session fixture") {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        }
        HostedAccessibility.activate(row)
        let opened = await awaitCondition { self.composerDraftText(in: window) != nil }
        XCTAssertTrue(opened, "The chat never opened beside the list")
        return Folding(fixture: fixture, window: window, display: display, inner: inner)
    }

    /// Closes the Duo onto its outer display (compact) or opens it onto the inner one (regular), as the device does:
    /// the same window takes the other display's size and size class.
    private func fold(_ folding: Folding, closed: Bool) {
        folding.window.frame = CGRect(origin: .zero, size: closed ? HostedSize.duoOuter : folding.inner)
        folding.window.traitOverrides.horizontalSizeClass = closed ? .compact : .regular
        folding.display.sizeClass = closed ? .compact : .regular
        folding.window.layoutIfNeeded()
        settle(0.3)
        let showsSplit = HostedAccessibility.splitViewController(under: folding.window.rootViewController) != nil
        XCTAssertEqual(showsSplit, !closed, closed ? "Closing the Duo kept the split view" : "Opening the Duo kept the stack")
    }

    func testArchivingAfterFoldingUsesTheCompactNewChatRoot() async throws {
        let folding = try await openChatOnInnerDisplay([UITestFixtureEnvironment.holdSessionRemovalArgument])
        let window = folding.window
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        fold(folding, closed: true)
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let ready = await awaitCondition { HostedAccessibility.titleMenuController(in: window) != nil }
        XCTAssertTrue(ready)
        let page = try XCTUnwrap(HostedAccessibility.titleMenuController(in: window))
        let navigation = try XCTUnwrap(page.navigationController)
        let menu = try XCTUnwrap(page.navigationItem.titleMenuProvider?([]))
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.menuActions(in: menu).first { $0.title == "Archive" }))
        let removed = await awaitNoElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertTrue(removed, "Archiving after a fold must immediately replace the compact chat")
        _ = try await requireElement(in: window, label: "Send")
        XCTAssertNil(HostedAccessibility.splitViewController(under: window.rootViewController))
        XCTAssertEqual(navigation.viewControllers.count, 1, "New Chat must be the compact root")
        XCTAssertNil(HostedAccessibility.titleMenuController(in: window))
        let held = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
        XCTAssertTrue(held, "The compact root must change before the archive response")
        folding.fixture.releaseHeldLoads()
    }

    private func chatRequests() -> [String] {
        UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter(Self.chatPaths.contains) }
    }

    func testARunningResponseKeepsItsStreamAndFetchesNothingAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay(["--ui-test-chat-controls"])
        let window = folding.window
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await Task.sleep(for: .milliseconds(500))
        let before = chatRequests()

        for closed in [true, false] {
            let moment = closed ? "Closing" : "Opening"
            fold(folding, closed: closed)
            _ = try await requireElement(in: window, label: "Stop response", "\(moment) the Duo lost the running response")
            // Sleeping, not `settle()`, so the rebuilt chat's main-actor tasks get to send anything they would.
            try await Task.sleep(for: .seconds(1))
            XCTAssertEqual(Array(chatRequests().dropFirst(before.count)), [], "\(moment) the Duo fetched the chat again")
            let pinned = await awaitCondition { (try? self.transcriptScrollView(in: window, timeout: 0)).map(self.isAtBottom) == true }
            XCTAssertTrue(pinned, "\(moment) the Duo moved a transcript that followed the response off the latest message")
        }

        HostedAccessibility.activate(try await requireElement(in: window, label: "Stop response"))
        _ = try await requireElement(in: window, label: "Stopped", "The run's end never reached the transcript")
    }

    func testTheReadersRowStaysAtTheTopAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay()
        let window = folding.window
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        settle(0.5)
        let scroll = try transcriptScrollView(in: window)
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        // A reader drags up into the middle of the transcript and lets go there.
        coordinator.scrollPositionController?.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        scroll.contentOffset.y = max(0, scroll.contentSize.height / 2)
        // The rows around the reader are built and measured before the finger lifts, as during a drag.
        _ = await awaitCondition { coordinator.scrollPositionController?.isRealizingRows == false }
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: false))
        let reading = try XCTUnwrap(readingRow(in: window), "No row at the top of the transcript")
        await attachRealizedTranscript(window, name: "duo-reader-1-open")

        for closed in [true, false] {
            fold(folding, closed: closed)
            let kept = await awaitCondition { self.readingRow(in: window) == reading }
            XCTAssertTrue(kept, "\(closed ? "Closing" : "Opening") the Duo moved the reader from \(reading) to \(readingRow(in: window) ?? "nothing")")
            await attachRealizedTranscript(window, name: closed ? "duo-reader-2-closed" : "duo-reader-3-reopened")
        }
    }

    func testTheSameChatKeepsListenAndDictationAcrossClosingAndOpening() async throws {
        let player = HostedListenPlayer()
        var viewModel: ChatViewModel!
        var session: SessionSummary!
        let chats = ChatViewModelCache()
        let folding = try await openChatOnInnerDisplay { fixture in
            session = try await fixture.session()
            viewModel = ChatViewModel(
                session: session,
                server: UITestFixtureEnvironment.serverURL,
                listenAudioSession: HostedListenAudioSession(),
                listenRemoteControlCenter: HostedListenRemoteControl(),
                serverTTSAudioPlayerFactory: { _ in player }
            )
            // The list hands this view model to the chat it opens.
            _ = chats.chat(for: session, server: UITestFixtureEnvironment.serverURL) { viewModel }
            return AnyView(fixture.sessionList(chats: chats))
        }
        let window = folding.window
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        let reply = try XCTUnwrap(viewModel.messages.lastIndex { $0.role == "assistant" })
        viewModel.toggleListening(to: try XCTUnwrap(viewModel.actionContext(for: viewModel.messages[reply], visibleIndex: reply)))
        let playing = await awaitCondition { viewModel.listenPlaybackPhase == .playing }
        XCTAssertTrue(playing, "Listen never started")
        player.currentTime = 12
        _ = try await requireElement(in: window, label: "0:12 of 1:00", "The Listen bar never showed the elapsed time")

        viewModel.voiceInput.beginListeningForTesting(currentDraft: "")
        viewModel.voiceInput.applyRecognizedTranscript("Fold")
        let started = await awaitCondition { self.composerDraftText(in: window) == "Fold" }
        XCTAssertTrue(started, "Dictation never reached the composer")

        for (closed, words) in [(true, "Fold the phone"), (false, "Fold the phone open")] {
            let moment = closed ? "closing" : "opening"
            fold(folding, closed: closed)
            let kept = chats.chat(for: session, server: UITestFixtureEnvironment.serverURL) {
                XCTFail("The chat's view model was not kept")
                return viewModel
            }
            XCTAssertTrue(kept.viewModel === viewModel, "The chat has a new view model after \(moment)")
            XCTAssertEqual(viewModel.listenPlaybackPhase, .playing, "Listen stopped on \(moment) the Duo")
            _ = try await requireElement(in: window, label: "0:12 of 1:00", "The Listen bar lost its place on \(moment)")
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Pause audio"), "Listen paused on \(moment)")

            XCTAssertTrue(viewModel.voiceInput.isListening, "Dictation stopped on \(moment) the Duo")
            viewModel.voiceInput.applyRecognizedTranscript(words)
            let dictated = await awaitCondition { self.composerDraftText(in: window) == words }
            XCTAssertTrue(dictated, "Dictation after \(moment) never reached the composer: \(composerDraftText(in: window) ?? "none")")
        }
        viewModel.voiceInput.stopBeforeSubmittingDraft()
        viewModel.stopListening()
    }

    func testAnExpandedDisclosureStaysExpandedAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay(["--ui-test-long-bodies"])
        let window = folding.window
        func isVisible(_ element: NSObject) -> Bool { window.bounds.contains(element.accessibilityFrame) }
        // The latest row finishes its entry before the toggle, as `testLongBodiesOpenCollapsedAndExpandInPlace` waits.
        var previousTail: CGRect?
        var stableSamples = 0
        let entered = await awaitCondition {
            guard let controller = window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator?.scrollPositionController,
                  !controller.isHoldingPosition,
                  let tail = HostedAccessibility.elements(in: window).first(where: { $0.accessibilityLabel == "Short reply 25." && isVisible($0) })
            else { stableSamples = 0; return false }
            stableSamples = tail.accessibilityFrame == previousTail ? stableSamples + 1 : 0
            previousTail = tail.accessibilityFrame
            return stableSamples >= 5
        }
        XCTAssertTrue(entered, "The latest row never finished its entry")
        // The latest long body, which stays in view at the latest message on either display.
        let showMore = try XCTUnwrap(HostedAccessibility.elements(in: window)
            .filter { $0.accessibilityLabel == "Show more" && isVisible($0) }
            .max { $0.accessibilityFrame.minY < $1.accessibilityFrame.minY }, "No collapsed long body near the latest message")
        HostedAccessibility.activate(showMore)
        // The expanded body is long enough that its Show less can sit below the screen.
        _ = try await requireElement(in: window, label: "Show less", "The long body did not expand")

        for closed in [true, false] {
            fold(folding, closed: closed)
            let expanded = await awaitElement(in: window, label: "Show less")
            XCTAssertNotNil(expanded, "\(closed ? "Closing" : "Opening") the Duo collapsed the expanded body")
        }
    }

    /// Folding consumes an explicit inspector presentation; unfolding needs a new Files tap.
    func testFilesDismissedByFoldingStaysClosedUntilAnotherTap() async throws {
        let folding = try await openChatOnInnerDisplay(size: HostedSize.duoInnerLandscape)
        let window = folding.window
        var files: NSObject?
        _ = await awaitCondition {
            files = self.allElements(in: window).first {
                $0.accessibilityLabel == "Files" && $0 is UIControl && window.bounds.contains($0.accessibilityFrame)
            }
            return files != nil
        }
        (try XCTUnwrap(files as? UIControl, "The chat has no Files button")).sendActions(for: .touchUpInside)
        let opened = await awaitCondition { self.showsFiles(in: window) }
        XCTAssertTrue(opened, "Files did not open beside the chat")

        fold(folding, closed: true)
        fold(folding, closed: false)
        XCTAssertFalse(self.showsFiles(in: window), "Unfolding must not re-present Files")
        let reopen = try XCTUnwrap(HostedAccessibility.toolbarAction("Files", in: window), "The chat lost its Files action")
        XCTAssertTrue(HostedAccessibility.activate(reopen))
        let reopened = await awaitCondition { self.showsFiles(in: window) }
        XCTAssertTrue(reopened, "A new Files tap must reopen the inspector")
    }

    private func showsFiles(in window: UIWindow) -> Bool {
        guard #available(iOS 26, *),
              let controller = window.rootViewController?.firstDescendant(ofType: FilesInspectorContent.NavigationController.self)
        else { return false }
        return controller.view.window != nil && controller.splitViewController?.isShowing(.inspector) == true
    }

    /// Both an object's accessibility children and its subviews: a column's element list leaves out its bar buttons.
    private func allElements(in object: NSObject) -> [NSObject] {
        var found = object.isAccessibilityElement ? [object] : []
        (object.accessibilityElements as? [NSObject])?.forEach { found += allElements(in: $0) }
        (object as? UIView)?.subviews.forEach { found += allElements(in: $0) }
        return found
    }

    private func isAtBottom(_ scroll: UIScrollView) -> Bool {
        scroll.contentOffset.y + scroll.bounds.height - scroll.adjustedContentInset.bottom >= scroll.contentSize.height - 2
    }

    /// Folding mid-drag detaches the scroll observer without a gesture end, so the row comes from the scrolling itself.
    func testAReaderStillDraggingKeepsTheRowAcrossClosing() async throws {
        let folding = try await openChatOnInnerDisplay()
        let window = folding.window
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        settle(0.5)
        let scroll = try transcriptScrollView(in: window)
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        coordinator.scrollPositionController?.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        scroll.contentOffset.y = max(0, scroll.contentSize.height / 2)
        _ = await awaitCondition { coordinator.scrollPositionController?.isRealizingRows == false }
        // The finger is still down: the drag's frames report it, and no `.userScrollEnd` comes before the Duo closes.
        // A raw offset is not a drag to UIKit, so the frame is sent as the observer sends one.
        coordinator.onFollowEvent(.contentScrolled(isAtBottom: false, isUserScrolling: true))
        let reading = try XCTUnwrap(readingRow(in: window), "No row at the top of the transcript")

        fold(folding, closed: true)
        let kept = await awaitCondition { self.readingRow(in: window) == reading }
        XCTAssertTrue(kept, "Closing the Duo mid-drag moved the reader from \(reading) to \(readingRow(in: window) ?? "nothing")")
    }

    /// The window once the transcript has built the rows around the reader. Row building runs on the main actor, which
    /// `settle()` keeps busy, so this waits by sleeping.
    private func attachRealizedTranscript(_ window: UIWindow, name: String) async {
        _ = await awaitCondition {
            window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator?.scrollPositionController?.isRealizingRows == false
        }
        attachHostedScreenshot(window, name: name)
    }

    /// The row at the top of the visible transcript, as the transcript measures it.
    private func readingRow(in window: UIWindow) -> String? {
        window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator?.scrollPositionController?.readingAnchorRowID
    }

    private func transcriptScrollView(in window: UIWindow, timeout: TimeInterval = 10) throws -> UIScrollView {
        var scroll: UIScrollView?
        waitUntil(timeout: timeout) {
            scroll = window.firstView(ofType: ChatMessageMenuHostView.self)?.superview.flatMap {
                sequence(first: $0, next: \.superview).first { $0 is UIScrollView } as? UIScrollView
            }
            return scroll != nil
        }
        return try XCTUnwrap(scroll, "The transcript's native scroll handler did not attach")
    }
}

/// The display a hosted Duo shows: its size class reaches the screens through the environment, as a fold's does.
@MainActor
@Observable
final class HostedDuoDisplay {
    var sizeClass: UserInterfaceSizeClass = .regular
}

private struct FoldingDisplay: View {
    let display: HostedDuoDisplay
    let content: AnyView

    var body: some View {
        content.environment(\.horizontalSizeClass, display.sizeClass)
    }
}

/// Listen playback without audio: it plays until stopped, at whatever time the test sets.
@MainActor
private final class HostedListenPlayer: ListenAudioPlaying {
    var onFinish: (@MainActor () -> Void)?
    var currentTime: TimeInterval = 0
    let duration: TimeInterval = 60
    var rate: Float = 1
    func prepareToPlay() {}
    func play() -> Bool { true }
    func pause() {}
    func stop() {}
}

private struct HostedListenAudioSession: ListenAudioSessionControlling {
    func activate() {}
    func deactivate() {}
}

private struct HostedListenRemoteControl: ListenRemoteControlControlling {
    func configure(
        play: @escaping @MainActor () -> Void,
        pause: @escaping @MainActor () -> Void,
        togglePlayPause: @escaping @MainActor () -> Void,
        changePlaybackPosition: @escaping @MainActor (TimeInterval) -> Void
    ) {}
    func update(_ snapshot: ListenNowPlayingSnapshot) {}
    func clear() {}
}

/// The chats the session list keeps (TAL-1477): only the one navigation shows, at most three, on one server.
@MainActor
final class ChatViewModelCacheTests: XCTestCase {
    private let server = URL(string: "https://one.invalid")!

    private func session(_ id: String) -> SessionSummary { SessionSummary(sessionId: id, title: id) }

    private func viewModel(_ id: String, on server: URL? = nil) -> ChatViewModel {
        ChatViewModel(session: session(id), server: server ?? self.server)
    }

    func testOpeningAndClosingThreeChatsTenTimesKeepsAtMostThree() {
        let cache = ChatViewModelCache()
        var made = 0
        for _ in 0..<10 {
            for id in ["a", "b", "c", "d"] {
                _ = cache.chat(for: session(id), server: server) { made += 1; return viewModel(id) }
                XCTAssertLessThanOrEqual(cache.count, ChatViewModelCache.capacity)
            }
        }
        XCTAssertEqual(cache.count, ChatViewModelCache.capacity)
    }

    func testTheSameChatGetsTheSameViewModel() {
        let cache = ChatViewModelCache()
        let first = cache.chat(for: session("a"), server: server) { viewModel("a") }
        let again = cache.chat(for: session("a"), server: server) {
            XCTFail("A kept chat was made again")
            return viewModel("a")
        }
        XCTAssertTrue(first === again)
    }

    func testSwitchingServersEmptiesIt() {
        let cache = ChatViewModelCache()
        _ = cache.chat(for: session("a"), server: server) { viewModel("a") }
        _ = cache.chat(for: session("b"), server: server) { viewModel("b") }
        let other = URL(string: "https://two.invalid")!
        _ = cache.chat(for: session("a"), server: other) { viewModel("a", on: other) }
        XCTAssertEqual(cache.count, 1)
    }

    func testOnlyTheChatNavigationShowsStays() {
        let cache = ChatViewModelCache()
        _ = cache.chat(for: session("a"), server: server) { viewModel("a") }
        _ = cache.chat(for: session("b"), server: server) { viewModel("b") }
        cache.keepOnly(sessionIDs: ["b"])
        XCTAssertEqual(cache.count, 1)
        cache.keepOnly(sessionIDs: [])
        XCTAssertEqual(cache.count, 0)
    }

    func testClearingTheSelectedSessionKeepsThePendingNewChatRoot() {
        let cache = ChatViewModelCache()
        _ = cache.chat(for: session("a"), server: server) { viewModel("a") }
        let route = PendingNewChatRoute()
        let pending = cache.pendingChat(for: route, server: server) { provisional in
            ChatViewModel(session: provisional, server: server)
        }

        cache.keepOnly(sessionIDs: [])

        XCTAssertEqual(cache.count, 1)
        let kept = cache.pendingChat(for: route, server: server) { provisional in
            XCTFail("The mounted pending root's view model was created again")
            return ChatViewModel(session: provisional, server: server)
        }
        XCTAssertTrue(kept === pending)
    }

    func testAViewTakesOverAChatOnlyWhileItIsLive() async {
        let chat = RetainedChat(viewModel: viewModel("a"))
        XCTAssertFalse(chat.viewDidAppear(), "A chat's first view starts it")
        var released = 0
        chat.viewDidDisappear { released += 1 }
        XCTAssertTrue(chat.viewDidAppear(), "A view rebuilt in the same update takes the chat over")
        await Task.yield()
        XCTAssertEqual(released, 0)

        chat.viewDidDisappear { released += 1 }
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(released, 1, "A chat no view takes over is released")
        XCTAssertFalse(chat.viewDidAppear(), "A view opening a released chat starts it again")
    }
}
