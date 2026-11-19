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
        list: @MainActor (FixtureApp) async throws -> AnyView = { AnyView($0.sessionList()) }
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

    private func fold(_ folding: Folding, closed: Bool) {
        foldDuo(folding.window, display: folding.display, inner: folding.inner, closed: closed)
    }

    func testDeepLinkedReplacementStartsWithTheOuterDisplaysVerticalToolbar() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the Duo vertical toolbar") }
        let scene = try HostedScene.current()
        try XCTSkipUnless(scene.traitCollection.verticalBarEdge != .unspecified, "Requires the Duo outer display")
        let fixture = try FixtureApp([UITestFixtureEnvironment.forkSessionArgument], for: self)
        let recorder = ChatBodyEvaluationRecorder()
        fixture.pendingSessionID = UITestFixtureURLProtocol.sessionID
        let window = try hostWindow(fixture.sessionList().environment(\.chatBodyEvaluation, recorder),
                                    size: scene.coordinateSpace.bounds.size)
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let moreID = "chat-session-actions-more"
        let ready = await awaitCondition {
            HostedAccessibility.toolbarItems(in: window).contains { $0.accessibilityIdentifier == moreID }
                && ["Open navigation", "New Chat", "Notifications"].allSatisfy {
                    HostedAccessibility.toolbarItem($0, in: window) != nil
                }
        }
        XCTAssertTrue(ready)
        let navigation = try XCTUnwrap(HostedAccessibility.titleMenuController(in: window)?.navigationController)
        let anchoredActions = ["Open navigation", "New Chat", "Notifications", "Settings"].filter {
            HostedAccessibility.toolbarItem($0, in: window) != nil
        }
        recorder.reset()
        var gaps = Set<String>()
        try await sampleCommittedLayouts(in: window) {
            for title in anchoredActions {
                if HostedAccessibility.toolbarItem(title, in: window) == nil { gaps.insert(title) }
            }
            if !HostedAccessibility.toolbarItems(in: window).contains(where: { $0.accessibilityIdentifier == moreID }) {
                gaps.insert("More")
            }
        } during: {
            fixture.pendingSessionID = UITestFixtureURLProtocol.forkSessionID
            _ = try await requireElement(in: window, label: "Fork fixture reply")
            settle(0.2)
        }
        XCTAssertGreaterThan(recorder.counts["toolbar.vertical", default: 0], 0)
        XCTAssertEqual(recorder.counts["toolbar.horizontal", default: 0], 0,
                       "The replacement chat's very first body must inherit the vertical axis")
        XCTAssertTrue(gaps.isEmpty, "The cover toolbar lost: \(gaps.sorted())")
        XCTAssertTrue(HostedAccessibility.titleMenuController(in: window)?.navigationController === navigation)
        attachHostedScreenshot(window, name: "duo-outer-deep-link-after")
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
        await releaseHeldRequest(of: folding.fixture)
    }

    private func chatRequests() -> [String] {
        let chatPaths = Self.chatPaths
        return UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter(chatPaths.contains) }
    }

    func testARunningResponseKeepsItsStreamAndFetchesNothingAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay(["--ui-test-chat-controls"])
        let window = folding.window
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        _ = await awaitRenderedQuiet(in: window) { self.chatRequests() }
        let before = chatRequests()

        for closed in [true, false] {
            let moment = closed ? "Closing" : "Opening"
            fold(folding, closed: closed)
            _ = try await requireElement(in: window, label: "Stop response", "\(moment) the Duo lost the running response")
            // Runs the rebuilt chat's main-actor tasks until its requests stop changing, so it sends anything it would.
            _ = await awaitRenderedQuiet(in: window) { self.chatRequests() }
            XCTAssertEqual(Array(chatRequests().dropFirst(before.count)), [], "\(moment) the Duo fetched the chat again")
            let pinned = await awaitCondition { (try? self.transcriptScrollView(in: window, timeout: 0)).map(self.isAtBottom) == true }
            XCTAssertTrue(pinned, "\(moment) the Duo moved a transcript that followed the response off the latest message")
        }

        HostedAccessibility.activate(try await requireElement(in: window, label: "Stop response"))
        _ = try await requireElement(in: window, label: "Stopped", "The run's end never reached the transcript")
    }

    /// The chat on the inner display with a message queued behind its held run.
    private func openChatWithAQueuedMessage() async throws -> Folding {
        let folding = try await openChatOnInnerDisplay(["--ui-test-chat-controls"])
        try await sendFromComposer("Run the deterministic fixture", in: folding.window)
        _ = try await requireElement(in: folding.window, label: "Waiting for control input.")
        try await sendFromComposer("/queue Queued across folding", in: folding.window)
        _ = try await requireElement(in: folding.window, label: "1 queued")
        return folding
    }

    /// TAL-850: folding hands the chat to a new view without leaving it, so a queued message stays queued and the draft
    /// stays as typed.
    func testAQueuedMessageStaysQueuedAcrossFolding() async throws {
        let folding = try await openChatWithAQueuedMessage()
        let window = folding.window
        settle(0.3)
        attachHostedScreenshot(window, name: "queued-before-leaving")

        for closed in [true, false] {
            let moment = closed ? "Closing" : "Opening"
            fold(folding, closed: closed)
            _ = try await requireElement(in: window, label: "1 queued", "\(moment) the Duo lost the queue")
            // Runs the main-actor work the fold queued, so a release the handover failed to cancel gets to run.
            _ = await awaitRenderedQuiet(in: window) {
                [HostedAccessibility.element(in: window, label: "1 queued") == nil ? "" : "queued", self.composerDraftText(in: window) ?? ""]
            }
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "1 queued"), "\(moment) the Duo emptied the queue")
            XCTAssertEqual(composerDraftText(in: window), "", "\(moment) the Duo moved the queue into the draft")
        }
    }

    /// TAL-850: leaving the chat moves its queued message into the draft, and returning sends nothing.
    func testAQueuedMessageBecomesTheDraftOnLeaving() async throws {
        let window = try await openChatWithAQueuedMessage().window
        func starts() -> Int { UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/chat/start" }.count } }
        let startsBefore = starts()
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))
        let left = await awaitNoElement(in: window) { $0.accessibilityLabel == "1 queued" }
        XCTAssertTrue(left, "New Chat never replaced the chat")
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, "The chat is no longer listed") {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        })
        let restored = await awaitCondition { self.composerDraftText(in: window) == "Queued across folding" }
        XCTAssertTrue(restored, "Returning showed \(composerDraftText(in: window) ?? "no composer"), not the queued message")
        settle(0.3)
        attachHostedScreenshot(window, name: "queued-message-restored-as-draft")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "1 queued"))
        _ = await awaitRenderedQuiet(in: window) { starts() }
        XCTAssertEqual(starts(), startsBefore, "Returning sent the queued message")
    }

    /// The editor mounted in the window, which a fold replaces with the other layout's.
    private func mountedEditor(in window: UIWindow) -> UITextView? {
        window.firstView(ofType: UITextView.self) { $0.isEditable }
    }

    /// TAL-2565: closing or opening the Duo replaces the chat's editor. A focused one hands over its draft, selection and
    /// keyboard, so the next keystroke lands where the writer left it.
    func testAFocusedDraftKeepsItsSelectionAndKeyboardAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay()
        let window = folding.window
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        try await typeIntoComposer("Fold this draft", in: window)
        var editor = try XCTUnwrap(mountedEditor(in: window))
        XCTAssertTrue(editor.isFirstResponder)
        // "this", in UTF-16 offsets.
        var selection = NSRange(location: 5, length: 4)
        editor.selectedRange = selection
        var draft = "Fold this draft"
        attachHostedScreenshot(window, name: "duo-focus-1-open-selected")

        for (closed, typed) in [(true, "the"), (false, "!")] {
            let moment = closed ? "Closing" : "Opening"
            let replaced = editor
            fold(folding, closed: closed)
            let handedOver = await awaitCondition {
                guard let mounted = self.mountedEditor(in: window), mounted !== replaced else { return false }
                return mounted.isFirstResponder && mounted.text == draft && mounted.selectedRange == selection
            }
            let mounted = mountedEditor(in: window)
            XCTAssertTrue(handedOver, """
                \(moment) the Duo left \(mounted === replaced ? "the same editor" : "a new editor") with \
                focus \(mounted?.isFirstResponder ?? false), text \(mounted?.text ?? "none"), \
                selection \(mounted.map { NSStringFromRange($0.selectedRange) } ?? "none")
                """)
            attachHostedScreenshot(window, name: closed ? "duo-focus-2-closed" : "duo-focus-3-reopened")
            editor = try XCTUnwrap(mounted)
            editor.insertText(typed)
            draft = (draft as NSString).replacingCharacters(in: selection, with: typed)
            selection = NSRange(location: selection.location + (typed as NSString).length, length: 0)
            let reached = await awaitCondition { self.composerDraftText(in: window) == draft }
            XCTAssertTrue(reached, "Typing after \(moment.lowercased()) wrote \(composerDraftText(in: window) ?? "nothing")")
        }
    }

    /// TAL-2565: only focus the writer left in place is handed over; a dismissed keyboard stays down.
    func testADismissedKeyboardStaysDownAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay()
        let window = folding.window
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        try await typeIntoComposer("Unfocused draft", in: window)
        XCTAssertTrue(try XCTUnwrap(mountedEditor(in: window)).resignFirstResponder())

        for closed in [true, false] {
            fold(folding, closed: closed)
            // Runs the rebuilt chat's main-actor work until the editor settles, so a focus request it queued gets to run.
            _ = await awaitRenderedQuiet(in: window) {
                [self.composerDraftText(in: window) ?? "", self.mountedEditor(in: window)?.isFirstResponder == true ? "focused" : ""]
            }
            XCTAssertEqual(composerDraftText(in: window), "Unfocused draft")
            XCTAssertFalse(mountedEditor(in: window)?.isFirstResponder ?? false,
                           "\(closed ? "Closing" : "Opening") the Duo raised a dismissed keyboard")
        }
    }

    func testTheReadersRowStaysAtTheTopAcrossClosingAndOpening() async throws {
        let folding = try await openChatOnInnerDisplay()
        let window = folding.window
        let reading = try await scrollReaderToMiddle(in: window)
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
        var waitingOn = "the transcript's scroll controller"
        let entered = await awaitCondition {
            func waitFor(_ reason: String) -> Bool {
                waitingOn = reason
                stableSamples = 0
                return false
            }
            guard let controller = window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator?.scrollPositionController
            else { return waitFor("the transcript's scroll controller") }
            guard !controller.isHoldingPosition else { return waitFor("the transcript's held position") }
            guard let tail = HostedAccessibility.elements(in: window).first(where: { $0.accessibilityLabel == "Short reply 25." && isVisible($0) })
            else { return waitFor("a visible latest row") }
            waitingOn = "a still latest row, last at \(tail.accessibilityFrame)"
            stableSamples = tail.accessibilityFrame == previousTail ? stableSamples + 1 : 0
            previousTail = tail.accessibilityFrame
            return stableSamples >= 5
        }
        XCTAssertTrue(entered, "The latest row never finished its entry, waiting on \(waitingOn)")
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
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(files, "The chat has no Files button")))
        let opened = await awaitCondition { self.showsFiles(in: window) }
        XCTAssertTrue(opened, "Files did not open beside the chat")

        fold(folding, closed: true)
        fold(folding, closed: false)
        XCTAssertFalse(self.showsFiles(in: window), "Unfolding must not re-present Files")
        let reopen = try XCTUnwrap(HostedAccessibility.toolbarAction("Files", in: window), "The chat lost its Files action")
        XCTAssertTrue(HostedAccessibility.activate(reopen))
        let reopened = await awaitCondition { self.showsFiles(in: window) }
        XCTAssertTrue(reopened, "A new Files tap must reopen the inspector")
        // UIKit can refuse that first presentation over a column it has not hidden yet and show it for a moment
        // again; the tap must still leave Files open once the layout settles (TAL-1670).
        settle(0.3)
        let stays = await awaitCondition { self.showsFiles(in: window) }
        XCTAssertTrue(stays, "Files closed again after the tap reopened it")
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

    /// TAL-2566: leaving a chat for another one and coming back from the sidebar reopens the reader's row, not the latest
    /// message, beside the list and in the closed Duo's drawer.
    func testRevisitingAChatBesideTheListReopensTheReadersRow() async throws {
        try await assertRevisitKeepsTheReadersRow(closed: false)
    }

    func testRevisitingAChatFromTheDrawerReopensTheReadersRow() async throws {
        try await assertRevisitKeepsTheReadersRow(closed: true)
    }

    private func assertRevisitKeepsTheReadersRow(closed: Bool) async throws {
        let folding = try await openChatOnInnerDisplay()
        let window = folding.window
        if closed {
            _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
            fold(folding, closed: true)
        }
        let reading = try await scrollReaderToMiddle(in: window)

        try await openOtherChat(in: window)
        let otherRow = readingRow(in: window)
        // Every frame that draws the returning transcript's rows draws them at the reader's row, never the latest first.
        var drawnRows = Set<String>()
        try await sampleCommittedLayouts(in: window) {
            guard let row = self.readingRow(in: window), row != otherRow,
                  let scroll = self.mountedTranscriptScrollView(in: window), self.drawsContent(scroll) else { return }
            drawnRows.insert(row)
        } during: {
            try await reopenFixtureChat(in: window)
            let kept = await awaitCondition { self.readingRow(in: window) == reading }
            XCTAssertTrue(kept, "Revisiting the chat moved the reader from \(reading) to \(readingRow(in: window) ?? "nothing")")
            let drawn = await awaitCondition { self.mountedTranscriptScrollView(in: window).map(self.drawsContent) == true }
            XCTAssertTrue(drawn, "The revisited transcript never drew its rows")
        }
        XCTAssertEqual(drawnRows, [reading], "Revisiting the chat drew other rows at the top before the reader's")
        await attachRealizedTranscript(window, name: closed ? "revisit-drawer" : "revisit-beside-list")
    }

    /// A reader who scrolled back down to the latest message reopens following it, so replies that arrive are in view.
    func testRevisitingAChatLeftAtTheLatestMessageReopensThere() async throws {
        let chats = ChatViewModelCache()
        let window = try await openChatOnInnerDisplay { AnyView($0.sessionList(chats: chats)) }.window
        _ = try await scrollReaderToMiddle(in: window)
        let scrolled = try transcriptScrollView(in: window)
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        coordinator.onFollowEvent(.userScrollBegin)
        scrolled.contentOffset.y = scrolled.contentSize.height - scrolled.bounds.height + scrolled.adjustedContentInset.bottom
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: true))
        XCTAssertTrue(isAtBottom(scrolled))

        try await revisitThroughAnotherChat(in: window)
        let scroll = try transcriptScrollView(in: window)
        let atLatest = await awaitCondition { self.isAtBottom(scroll) }
        XCTAssertTrue(atLatest, "A chat left on its latest message reopened away from it")
        XCTAssertNil(fixtureChat(in: chats).readingRowID, "A chat left on its latest message reopened anchored to a row")
    }

    /// A row the transcript no longer has opens on the latest message, which keeps following.
    func testRevisitingAChatWhoseRowIsGoneOpensAtTheLatestMessage() async throws {
        let chats = ChatViewModelCache()
        let window = try await openChatOnInnerDisplay { AnyView($0.sessionList(chats: chats)) }.window
        _ = try await scrollReaderToMiddle(in: window)
        fixtureChat(in: chats).readingRowID = "chat-row-deleted"

        try await revisitThroughAnotherChat(in: window)
        let scroll = try transcriptScrollView(in: window)
        let atLatest = await awaitCondition { self.isAtBottom(scroll) }
        XCTAssertTrue(atLatest, "A chat whose reading row is gone did not open on its latest message")
        let drawn = await awaitCondition { self.drawsContent(scroll) }
        XCTAssertTrue(drawn, "A chat whose reading row is gone never drew its rows")
        let following = await awaitCondition { self.fixtureChat(in: chats).readingRowID == nil }
        XCTAssertTrue(following, "A chat whose reading row is gone did not follow its latest message")
    }

    /// The fixture chat the list keeps while it is open.
    private func fixtureChat(in chats: ChatViewModelCache) -> RetainedChat {
        let summary = SessionSummary(sessionId: UITestFixtureURLProtocol.sessionID, title: UITestFixtureURLProtocol.sessionTitle)
        return chats.chat(for: summary, server: UITestFixtureEnvironment.serverURL) {
            XCTFail("The open chat was made again")
            return ChatView.makeViewModel(session: summary, server: UITestFixtureEnvironment.serverURL)
        }
    }

    /// Opens "Fixture Session 01" from the sidebar, then the fixture chat again.
    private func revisitThroughAnotherChat(in window: UIWindow) async throws {
        try await openOtherChat(in: window)
        try await reopenFixtureChat(in: window)
        _ = try await requireElement(in: window, "The transcript never reloaded", where: FixtureApp.isLoadedTranscriptRow)
    }

    private func openOtherChat(in window: UIWindow) async throws {
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Fixture Session 01") == true
        })
        _ = try await requireElement(in: window, label: "Fixture Session 01 reply")
    }

    private func reopenFixtureChat(in window: UIWindow) async throws {
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        })
    }

    /// Whether `view` draws anything besides one background color, as its committed layers render.
    private func drawsContent(_ view: UIView) -> Bool {
        let size = CGSize(width: 32, height: 48)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            context.cgContext.scaleBy(x: size.width / view.bounds.width, y: size.height / view.bounds.height)
            context.cgContext.translateBy(x: -view.bounds.minX, y: -view.bounds.minY)
            view.layer.render(in: context.cgContext)
        }
        guard let data = image.cgImage?.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return false }
        let count = CFDataGetLength(data)
        return stride(from: 4, to: count, by: 4).contains { pixel in
            (0..<4).contains { abs(Int(bytes[pixel + $0]) - Int(bytes[$0])) > 8 }
        }
    }

    /// A reader drags up into the middle of the transcript and lets go there; returns the row at its top.
    private func scrollReaderToMiddle(in window: UIWindow) async throws -> String {
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        settle(0.5)
        let scroll = try transcriptScrollView(in: window)
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        coordinator.scrollPositionController?.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        scroll.contentOffset.y = max(0, scroll.contentSize.height / 2)
        // The rows around the reader are built and measured before the finger lifts, as during a drag.
        _ = await awaitCondition { coordinator.scrollPositionController?.isRealizingRows == false }
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: false))
        return try XCTUnwrap(readingRow(in: window), "No row at the top of the transcript")
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
            scroll = mountedTranscriptScrollView(in: window)
            return scroll != nil
        }
        return try XCTUnwrap(scroll, "The transcript's native scroll handler did not attach")
    }

    private func mountedTranscriptScrollView(in window: UIWindow) -> UIScrollView? {
        window.firstView(ofType: ChatMessageMenuHostView.self)?.superview.flatMap {
            sequence(first: $0, next: \.superview).first { $0 is UIScrollView } as? UIScrollView
        }
    }
}

/// The display a hosted Duo shows: its size class reaches the screens through the environment, as a fold's does.
@MainActor
@Observable
final class HostedDuoDisplay {
    var sizeClass: UserInterfaceSizeClass = .regular
}

extension XCTestCase {
    /// Closes the Duo onto its outer display (compact) or opens it onto the inner one (regular), as the device does:
    /// the same window takes the other display's size and size class.
    @MainActor
    func foldDuo(_ window: UIWindow, display: HostedDuoDisplay, inner: CGSize, closed: Bool) {
        window.frame = CGRect(origin: .zero, size: closed ? HostedSize.duoOuter : inner)
        window.traitOverrides.horizontalSizeClass = closed ? .compact : .regular
        display.sizeClass = closed ? .compact : .regular
        window.layoutIfNeeded()
        settle(0.3)
        let showsSplit = HostedAccessibility.splitViewController(under: window.rootViewController) != nil
        XCTAssertEqual(showsSplit, !closed, closed ? "Closing the Duo kept the split view" : "Opening the Duo kept the stack")
    }
}

/// The Duo's displays as SwiftUI sees them: closing it makes the content compact.
struct FoldingDisplay: View {
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

    /// TAL-2566: a released chat's reading row comes back with the chat, on its own server only.
    func testAReleasedChatsReadingRowReturnsOnlyOnItsServer() {
        let cache = ChatViewModelCache()
        cache.chat(for: session("a"), server: server) { viewModel("a") }.readingRowID = "row-a"
        cache.keepOnly(sessionIDs: [])
        let other = URL(string: "https://two.invalid")!
        XCTAssertNil(cache.chat(for: session("a"), server: other) { viewModel("a", on: other) }.readingRowID)
        XCTAssertEqual(cache.chat(for: session("a"), server: server) { viewModel("a") }.readingRowID, "row-a")
    }

    /// A chat started from New Chat keeps its reading row for the sidebar row of the session it created.
    func testANewChatsReadingRowReturnsWithItsCreatedSession() {
        let cache = ChatViewModelCache()
        let pending = cache.pendingChat(for: PendingNewChatRoute(), server: server) { provisional in
            ChatViewModel(session: provisional, server: server)
        }
        pending.session = session("created")
        pending.readingRowID = "row-created"
        cache.keepOnly(sessionIDs: ["other"])
        XCTAssertEqual(cache.chat(for: session("created"), server: server) { viewModel("created") }.readingRowID, "row-created")
    }

    func testOnlyTheMostRecentReadingRowsStay() {
        let cache = ChatViewModelCache()
        for index in 0...ChatViewModelCache.bookmarkCapacity {
            cache.chat(for: session("\(index)"), server: server) { viewModel("\(index)") }.readingRowID = "row-\(index)"
        }
        cache.keepOnly(sessionIDs: [])
        XCTAssertNil(cache.chat(for: session("0"), server: server) { viewModel("0") }.readingRowID)
        XCTAssertEqual(cache.chat(for: session("1"), server: server) { viewModel("1") }.readingRowID, "row-1")
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

        let releaseCompleted = expectation(description: "The chat is released")
        chat.viewDidDisappear {
            released += 1
            releaseCompleted.fulfill()
        }
        await fulfillment(of: [releaseCompleted], timeout: 1)
        XCTAssertEqual(released, 1, "A chat no view takes over is released")
        XCTAssertFalse(chat.viewDidAppear(), "A view opening a released chat starts it again")
    }
}
