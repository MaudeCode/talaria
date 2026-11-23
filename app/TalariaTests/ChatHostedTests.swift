import Darwin
import SwiftData
import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The fixture chat's media, long bodies, background work and pending steers, hosted in process (TAL-856).
@MainActor
final class ChatHostedTests: XCTestCase {
    func testReasoningHideClearsRetainedLiveContentAndTitles() async throws {
        let fixture = try FixtureApp(for: self)
        let stream = ScriptedSSEStreamingClient()
        var show = true
        let summary = SessionSummary(sessionId: "session-abc", title: "Reasoning visibility")
        let model = try makeScriptedChatViewModel(streamClient: stream, sessionSummary: summary) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"reasoning-run"}"#, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {"session":{"session_id":"session-abc","title":"Reasoning visibility","show_reasoning":\(show),"active_stream_id":"reasoning-run","messages":[{"role":"user","content":"Check this","message_id":"prompt"}]}}
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(#"{"active":true,"stream_id":"reasoning-run"}"#, for: request)
            case "/api/reasoning":
                if request.httpMethod == "POST" { show = (try apiTestJSONBody(from: request))["display"] as? String == "show" }
                return apiTestJSONResponse("{\"show_reasoning\":\(show)}", for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        defer {
            model.suspendStreamForNavigation()
            model.cleanupPollingTasks()
            stream.stop()
            ChatViewModel.resetActiveStreamSnapshotsForTesting()
        }
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://example.test")!, onAPIError: { _ in },
                     loadsInitialMessages: false, viewModel: model)
        }.modelContainer(fixture.cache))
        let started = await model.sendMessage("Check this")
        XCTAssertTrue(started)
        stream.emit(.reasoning(ReasoningStreamEvent(text: "Private retained reasoning", titles: ["Private retained heading"])))
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Private retained heading") == true }
        attachHostedScreenshot(window, name: "reasoning-live-before-hide")
        let result = await model.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "reasoning")), args: "hide")
        XCTAssertEqual(result, .executed(message: nil), "Display changes must remain available during a live turn")
        let hidden = await awaitCondition {
            !HostedAccessibility.labels(in: window).contains { $0.contains("Private retained heading") || $0.contains("Private retained reasoning") }
        }
        XCTAssertTrue(hidden, "The explicit display choice must hide retained live content and summary titles")
        let transcript = try transcriptScrollView(in: window)
        _ = try await requireElement(in: window) {
            $0.accessibilityLabel?.contains("Check this") == true
                && window.convert(transcript.bounds, from: transcript).intersects(window.convert($0.accessibilityFrame, from: nil))
        }
        XCTAssertNotNil(model.activeStreamID, "Hiding reasoning must keep the generic running state")
        attachHostedScreenshot(window, name: "reasoning-live-after-hide")
    }

    /// TAL-2331: a call the server marks `hidden` (a tool lookup while Settings hides them) never shows in the transcript;
    /// a lookup whose completion failed shows.
    func testHiddenToolLookupsStayOutOfTheTranscriptUntilOneFails() async throws {
        let fixture = try FixtureApp(for: self)
        let stream = ScriptedSSEStreamingClient()
        let summary = SessionSummary(sessionId: "session-lookups", title: "Tool lookups")
        let model = try makeScriptedChatViewModel(streamClient: stream, sessionSummary: summary) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-lookups","stream_id":"lookup-run"}"#, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {"session":{"session_id":"session-lookups","title":"Tool lookups","active_stream_id":"lookup-run","messages":[{"role":"user","content":"Find it","message_id":"prompt"}]}}
                """, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(#"{"active":true,"stream_id":"lookup-run"}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        defer {
            model.suspendStreamForNavigation()
            model.cleanupPollingTasks()
            stream.stop()
            ChatViewModel.resetActiveStreamSnapshotsForTesting()
        }
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://example.test")!, onAPIError: { _ in },
                     loadsInitialMessages: false, viewModel: model)
        }.modelContainer(fixture.cache))
        let started = await model.sendMessage("Find it")
        XCTAssertTrue(started)
        stream.emit(SSEEventDecoder.decode(eventType: "tool", data: #"{"id":"hidden","name":"tool_describe","kind":"read","target":"lookupnames","hidden":true}"#))
        stream.emit(SSEEventDecoder.decode(eventType: "tool", data: #"{"id":"read","name":"read_file","kind":"read","target":"visible.txt"}"#))
        stream.emit(SSEEventDecoder.decode(eventType: "tool_complete", data: #"{"id":"read","name":"read_file","kind":"read","target":"visible.txt","is_error":false}"#))
        stream.emit(SSEEventDecoder.decode(eventType: "tool", data: #"{"id":"failed","name":"tool_search","kind":"search","target":"failedquery","hidden":true}"#))
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("visible.txt") == true }
        let labels = { HostedAccessibility.labels(in: window) }
        XCTAssertFalse(labels().contains { $0.contains("lookupnames") || $0.contains("failedquery") }, "Hidden lookups stay out of the transcript")
        attachHostedScreenshot(window, name: "tool-lookups-hidden")
        stream.emit(SSEEventDecoder.decode(eventType: "tool_complete", data: #"{"id":"failed","name":"tool_search","kind":"search","target":"failedquery","is_error":true}"#))
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("failedquery") == true }
        XCTAssertFalse(labels().contains { $0.contains("lookupnames") }, "A lookup that did not fail stays hidden")
        attachHostedScreenshot(window, name: "tool-lookups-failed-shown")
    }

    /// TAL-839: an external chat shows at once and stays read-only, saying why, until the server verifies it.
    func testChatHeaderOmitsPlaceWhenTheServerSendsNull() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-without-place"], for: self)
        let session = try await fixture.session()
        let title = try XCTUnwrap(session.title)
        let window = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let header = try await requireElement(in: window) { ($0.accessibilityLabel ?? "").hasPrefix(title) }
        XCTAssertEqual(header.accessibilityLabel, title)
        attachHostedScreenshot(window, name: "chat-header-no-place")
    }

    func testExternalChatChecksAccessUntilTheServerVerifiesIt() async throws {
        let fixture = try FixtureApp(for: self)
        let release = DispatchSemaphore(value: 0)
        let summary = SessionSummary(sessionId: "cli-hosted", title: "CLI chat", isCliSession: true, accessProvisional: true)
        let model = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient(), sessionSummary: summary) { request in
            guard request.url?.path == "/api/session" else { return apiTestJSONResponse("{}", for: request) }
            XCTAssertEqual(release.wait(timeout: .now() + .seconds(10)), .success)
            return apiTestJSONResponse("""
            {"session":{"session_id":"cli-hosted","title":"CLI chat","is_cli_session":true,"read_only":false,
             "messages":[{"role":"assistant","content":"Started in the terminal","message_id":"cli"}]}}
            """, for: request)
        }
        defer {
            release.signal()
            model.suspendStreamForNavigation()
            model.cleanupPollingTasks()
        }
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://example.test")!, onAPIError: { _ in }, viewModel: model)
        }.modelContainer(fixture.cache))

        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Checking access") == true }
        XCTAssertTrue(model.isComposerReadOnly)
        attachHostedScreenshot(window, name: "external-chat-checking-access")

        release.signal()
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Started in the terminal") == true }
        let verified = await awaitCondition {
            !model.isComposerReadOnly && !HostedAccessibility.labels(in: window).contains { $0.contains("Checking access") }
        }
        XCTAssertTrue(verified, "The verified chat must take input")
        attachHostedScreenshot(window, name: "external-chat-verified")
    }

    private struct FoldHost: View {
        let content: AnyView
        var division = CGRect(x: 430, y: -100, width: 40, height: 2000)
        @State private var folded = false
        var body: some View {
            content
                .environment(\.chatDivisionFramesForTesting, folded
                    ? [division] : [])
                .overlay(alignment: .topLeading) {
                    Button("Toggle fixture fold") { folded.toggle() }
                }
        }
    }

    func testUnrelatedSessionListRefreshDoesNotEvaluateTheOpenChatBody() async throws {
        let fixture = try FixtureApp(for: self)
        let list = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        let chats = ChatViewModelCache()
        let evaluations = ChatBodyEvaluationRecorder()
        let window = try hostWindow(fixture.sessionList(chats: chats, viewModel: list)
            .environment(\.chatBodyEvaluation, evaluations))
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        })
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let summary = try await fixture.session()
        let retained = chats.chat(for: summary, server: UITestFixtureEnvironment.serverURL) {
            XCTFail("The open chat must already be retained")
            return ChatView.makeViewModel(session: summary, server: UITestFixtureEnvironment.serverURL)
        }
        let ready = await awaitCondition { retained.hasLoaded }
        XCTAssertTrue(ready, "Chat startup must finish before measuring the list refresh")
        _ = try await fixture.client.archiveSession(id: "ui-fixture-session-17", archived: true)
        let settled = await awaitQuietRowRealization(retained.rows)
        let before = try XCTUnwrap(settled, "Transcript row realization must be quiet before measuring the list refresh")
        evaluations.reset()
        let loaded = await list.load(modelContext: fixture.cache.mainContext)
        XCTAssertTrue(loaded)
        XCTAssertFalse(list.sessions.contains { $0.sessionId == "ui-fixture-session-17" })
        settle(0.5)
        XCTAssertEqual(evaluations.counts["chat", default: 0], 0, "An unrelated list refresh evaluated ChatView.body")
        XCTAssertEqual(retained.rows.realizationCount, before, "An unrelated list refresh realized transcript rows")
    }

    /// Reads the pushed chat's composer, and keeps what it read when the push completed.
    @MainActor private final class PushProbe {
        var window: UIWindow?
        var atCompletion: (opacity: Float, top: CGFloat)?

        /// The composer's + is a UIKit menu button in both composer presentations, and the leading one outside a scroll
        /// view: the control strip's chips scroll, and Send is trailing. SwiftUI leaves a hidden composer's UIKit views
        /// out of the window, so a missing button reads as invisible.
        func composer() -> (opacity: Float, top: CGFloat) {
            guard let window else { return (0, .nan) }
            let buttons = Self.menuButtons(in: window).map { ($0, $0.convert($0.bounds, to: window)) }
            guard let plus = buttons.min(by: { $0.1.minX < $1.1.minX }) else { return (0, .nan) }
            let opacity = sequence(first: plus.0.layer, next: \.superlayer).reduce(Float(1)) { $0 * ($1.isHidden ? 0 : $1.opacity) }
            // The + sits at a fixed offset from the bottom-anchored card's top, so its top tracks the card's height.
            return (opacity, plus.1.minY)
        }

        private static func menuButtons(in view: UIView) -> [UIButton] {
            guard !(view is UIScrollView) else { return [] }
            return [view as? UIButton].compactMap { $0 }.filter(\.showsMenuAsPrimaryAction) + view.subviews.flatMap(menuButtons)
        }
    }

    /// TAL-1679: the composer slides in with the chat at its measured size; it does not wait for the push to finish.
    /// TAL-1998: and loading the chat after the push does not move it.
    func testComposerShowsAtItsSettledSizeDuringThePush() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let probe = PushProbe()
        // Reads the composer from the same push-completion callback as the chat's own observer, before SwiftUI
        // renders what the chat's report changes.
        let chat = fixture.chat(session, asNavigationDestination: false)
            .background(NavigationAppearanceCompletionObserver { probe.atCompletion = probe.composer() })
        probe.window = try hostWindow(FixturePushHost(destination: chat), animationsEnabled: true)
        let window = try XCTUnwrap(probe.window)
        var shownTops: [CGFloat] = []
        try await sampleCommittedLayouts(in: window) {
            guard probe.atCompletion == nil else { return }
            let current = probe.composer()
            if current.opacity > 0 { shownTops.append(current.top) }
        } during: {
            let open = try await requireElement(in: window, label: "Open fixture chat")
            // UIKit animates a push only once the stack's root has appeared; a tap that came first pushed without a
            // transition, so no frame ever showed the composer sliding in (TAL-2543).
            await awaitDisplayUpdates(2, in: try XCTUnwrap(window.windowScene))
            HostedAccessibility.activate(open)
            let finished = await awaitCondition { probe.atCompletion != nil }
            XCTAssertTrue(finished, "The chat push must finish")
        }
        let pushed = try XCTUnwrap(probe.atCompletion)
        XCTAssertEqual(pushed.opacity, 1, "The composer must be visible while the chat slides in")
        XCTAssertFalse(shownTops.isEmpty, "The chat must slide in, with the composer drawn during the push")
        // Where the composer stood when it used to appear, once the push had finished.
        XCTAssertTrue(shownTops.allSatisfy { abs($0 - pushed.top) < 0.5 },
                      "The composer must never show at a provisional size: \(shownTops) against \(pushed.top)")
        // TAL-1998: the session load that starts once the push finishes adds the toolsets chip; the composer stays put.
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let settled = await awaitRenderedQuiet(in: window) { probe.composer().top }
        XCTAssertTrue(settled, "The loaded chat's composer must settle")
        attachHostedScreenshot(window, name: "composer-after-chat-load")
        XCTAssertEqual(probe.composer().top, pushed.top, accuracy: 0.5, "The composer moved once the chat had loaded")
    }

    func testBookFoldMovesComposerAndUnfoldingRetainsItsEditorAndDraft() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let window = try hostWindow(FoldHost(content: AnyView(fixture.chat(session))),
                                    size: CGSize(width: 900, height: 700))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        try await typeIntoComposer("Retained fold draft", in: window)
        let loadedEditor = await composerTextView(in: window)
        let editor = try XCTUnwrap(loadedEditor)
        let initialFrame = editor.convert(editor.bounds, to: window)
        XCTAssertLessThan(initialFrame.minX, 430)
        XCTAssertTrue(editor.isFirstResponder)
        settle(0.3)
        attachHostedScreenshot(window, name: "composer-before-book-fold")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let displaced = await awaitCondition { editor.convert(editor.bounds, to: window).minX >= 470 }
        XCTAssertTrue(displaced, "The composer editor still crosses the book fold")
        XCTAssertEqual(editor.text, "Retained fold draft")
        let foldedEditor = await composerTextView(in: window)
        XCTAssertTrue(foldedEditor === editor, "Folding must retain the text input instance")
        XCTAssertTrue(editor.isFirstResponder, "Folding must retain keyboard focus")
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertGreaterThanOrEqual(window.convert(send.accessibilityFrame, from: nil).minX, 470)
        let transcript = try transcriptScrollView(in: window)
        XCTAssertGreaterThan(transcript.bounds.width, 800, "The transcript must remain full width")
        settle(0.3)
        attachHostedScreenshot(window, name: "composer-after-book-fold")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let restored = await awaitCondition { editor.convert(editor.bounds, to: window).minX < 430 }
        XCTAssertTrue(restored)
        let restoredEditor = await composerTextView(in: window)
        XCTAssertTrue(restoredEditor === editor)
        XCTAssertEqual(editor.text, "Retained fold draft")
        XCTAssertTrue(editor.isFirstResponder)
    }

    /// TAL-2569: at the largest accessibility text size, a landscape pane shortened by the keyboard still shows a whole
    /// line of the draft with its caret, and Send stays inside the window, through a rotation and back.
    func testAccessibilityTextKeepsAWholeDraftLineInAShortLandscapePane() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        // The chat loads in portrait: at this size a landscape composer leaves the transcript no room.
        let portrait = CGSize(width: 402, height: 874)
        let draft = "Keep this accessibility draft visible"
        let window = try hostWindow(fixture.chat(session, initialDraft: draft), size: portrait) {
            $0.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        }
        // At this size only the newest reply fits on screen.
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("FixturePlainLead") == true }
        let loadedEditor = await composerTextView(in: window)
        let editor = try XCTUnwrap(loadedEditor)
        // The short frame below already models the space the software keyboard takes.
        // Use a local input view so the real editor keeps editing without depending on the keyboard service.
        editor.inputView = UIView(frame: .zero)
        XCTAssertTrue(editor.becomeFirstResponder(), "The editor must focus before the first resize")
        editor.selectedRange = NSRange(location: (draft as NSString).length, length: 0)
        let lineHeight = try XCTUnwrap(editor.font).lineHeight
        let selection = editor.selectedRange
        // The keyboard leaves a landscape chat about 200 pt. Rotate there, back to portrait, and there again.
        let landscape = CGSize(width: 874, height: 200)
        for (size, name) in [(landscape, "landscape"), (portrait, "portrait"), (landscape, "landscape-again")] {
            window.frame.size = size
            let settled = await awaitRenderedQuiet(in: window) { editor.convert(editor.bounds, to: window) }
            XCTAssertTrue(settled, "\(name): the composer must settle")
            attachHostedScreenshot(window, name: "composer-accessibility-\(name)")
            // The text container can reflow after the editor frame settles.
            _ = await awaitCondition {
                guard let end = editor.selectedTextRange?.end else { return false }
                return editor.bounds.insetBy(dx: -1, dy: -1).contains(editor.caretRect(for: end))
            }
            XCTAssertGreaterThanOrEqual(editor.bounds.height, lineHeight, "\(name): the editor cuts its line")
            let caret = editor.caretRect(for: try XCTUnwrap(editor.selectedTextRange).end)
            XCTAssertTrue(editor.bounds.insetBy(dx: -1, dy: -1).contains(caret),
                          "\(name): the caret \(caret) is outside the editor's visible \(editor.bounds)")
            let editorFrame = editor.convert(editor.bounds, to: window)
            XCTAssertTrue(window.bounds.contains(editorFrame), "\(name): the editor \(editorFrame) leaves the window")
            let send = try await requireElement(in: window, label: "Send")
            // At this size Send is about half the pane tall, so its circle may meet the keyboard; its hit point may not.
            let sendFrame = window.convert(send.accessibilityFrame, from: nil)
            XCTAssertTrue(window.bounds.contains(CGPoint(x: sendFrame.midX, y: sendFrame.midY)),
                          "\(name): Send \(sendFrame) has its hit point outside the window")
            XCTAssertEqual(editor.text, draft, name)
            XCTAssertEqual(editor.selectedRange, selection, name)
            XCTAssertTrue(editor.isFirstResponder, name)
        }
    }

    /// The vertical bar has no keyboard accessory row, so it carries its own Hide Keyboard while the composer is
    /// focused (TAL-1584). A horizontal bar never shows it.
    func testVerticalBarHidesTheKeyboardWhileTheComposerIsFocused() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        func hideKeyboard(in window: UIWindow) -> UIBarButtonItem? {
            HostedAccessibility.toolbarItems(in: window).first { $0.accessibilityIdentifier == "chat-hide-keyboard" }
        }
        for vertical in [true, false] {
            let window = try hostWindow(fixture.chat(session).environment(\.navigationHasVerticalToolbar, vertical))
            _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
            XCTAssertNil(hideKeyboard(in: window), "Hide Keyboard must wait for the composer's focus")
            try await typeIntoComposer("Draft", in: window)
            let loadedEditor = await composerTextView(in: window)
            let editor = try XCTUnwrap(loadedEditor)
            XCTAssertTrue(editor.isFirstResponder)
            guard vertical else {
                settle(0.3)
                XCTAssertNil(hideKeyboard(in: window), "A horizontal bar must not show Hide Keyboard")
                window.isHidden = true
                window.rootViewController = nil
                continue
            }
            let shown = await awaitCondition { hideKeyboard(in: window) != nil }
            XCTAssertTrue(shown, "A focused composer must add Hide Keyboard to the vertical bar")
            let item = try XCTUnwrap(hideKeyboard(in: window))
            XCTAssertEqual(item.accessibilityLabel ?? item.title, "Hide Keyboard")
            XCTAssertTrue(HostedAccessibility.activate(item))
            let hidden = await awaitCondition { !editor.isFirstResponder && hideKeyboard(in: window) == nil }
            XCTAssertTrue(hidden, "Hide Keyboard must end editing and leave the bar")
            // Any other blur, such as a transcript swipe, also removes it.
            XCTAssertTrue(editor.becomeFirstResponder())
            let refocused = await awaitCondition { hideKeyboard(in: window) != nil }
            XCTAssertTrue(refocused)
            editor.resignFirstResponder()
            let blurred = await awaitCondition { hideKeyboard(in: window) == nil }
            XCTAssertTrue(blurred, "Hide Keyboard must leave the bar when the composer loses focus")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testTabletopPartitionsTranscriptAndComposerWithoutLosingTheDraft() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let fold = CGRect(x: -100, y: 330, width: 2000, height: 40)
        let recorder = ChatBodyEvaluationRecorder()
        var transcriptFrame: CGRect { recorder.transcriptFrame }
        // A pushed page in an oversized window inherits the physical cover's bottom inset on iOS 27.1.
        // This geometry fixture owns its full canvas; navigation is covered by the book-fold and section tests.
        let chat = fixture.chat(session, asNavigationDestination: false)
            .ignoresSafeArea(.container)
            .environment(\.chatBodyEvaluation, recorder)
        let window = try hostWindow(FoldHost(content: AnyView(chat), division: fold),
                                    size: CGSize(width: 900, height: 900))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertFalse(transcriptFrame.isNull)
        let foldInWindow = fold.offsetBy(dx: 0, dy: transcriptFrame.minY)
        let draft = (1...20).map { "Retained tabletop draft line \($0)" }.joined(separator: "\n")
        try await typeIntoComposer(draft, in: window)
        let loadedEditor = await composerTextView(in: window)
        let editor = try XCTUnwrap(loadedEditor)
        editor.resignFirstResponder()
        settle(0.5)
        let flatHeight = editor.bounds.height
        let composerControls = Set(HostedAccessibility.elements(in: window).filter {
            $0.accessibilityTraits.contains(.button)
                && window.convert($0.accessibilityFrame, from: nil).minY >= editor.convert(editor.bounds, to: window).minY
        }.compactMap(\.accessibilityLabel))
        attachHostedScreenshot(window, name: "tabletop-before-flat")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let transcript = try transcriptScrollView(in: window)
        // Height measurement can briefly overshoot after a valid partition; wait for settled geometry.
        var previousFrames: [CGRect] = []
        var stableSamples = 0
        let partitioned = await awaitCondition {
            let frames = [transcriptFrame, editor.convert(editor.bounds, to: window)]
            stableSamples = frames == previousFrames ? stableSamples + 1 : 0
            previousFrames = frames
            return stableSamples >= 5
                && frames[0].maxY <= foldInWindow.minY + 1
                && frames[1].minY >= foldInWindow.maxY
                && editor.bounds.height > flatHeight + 30
        }
        XCTAssertTrue(partitioned, "The tabletop transcript and draft editor did not finish laying out: \(transcriptFrame), fold \(foldInWindow), editor height \(editor.bounds.height)")
        XCTAssertGreaterThanOrEqual(editor.convert(editor.bounds, to: window).minY, foldInWindow.maxY)
        XCTAssertGreaterThan(editor.bounds.height, flatHeight + 30, "A long draft must grow into the tabletop control region")
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertGreaterThanOrEqual(window.convert(send.accessibilityFrame, from: nil).minY, foldInWindow.maxY)
        XCTAssertEqual(editor.text, draft)
        attachHostedScreenshot(window, name: "tabletop-after-fold")
        for label in composerControls {
            let control = try await requireElement(in: window, label: label)
            XCTAssertGreaterThanOrEqual(window.convert(control.accessibilityFrame, from: nil).minY, foldInWindow.maxY,
                "The tabletop composer lost or displaced \(label) across the fold")
        }

        // System keyboard notifications are the integration seam; native keyboard geometry is checked separately.
        NotificationCenter.default.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        let keyboardWins = await awaitCondition { transcriptFrame.maxY > foldInWindow.maxY }
        XCTAssertTrue(keyboardWins, "The keyboard must suspend tabletop partitioning")
        NotificationCenter.default.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        let tabletopReturns = await awaitCondition { transcriptFrame.maxY <= foldInWindow.minY + 1 }
        XCTAssertTrue(tabletopReturns, "Dismissing the keyboard must restore tabletop partitioning")
        XCTAssertEqual(editor.text, draft)

        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let restored = await awaitCondition { transcript.convert(transcript.bounds, to: window).maxY > 600 }
        XCTAssertTrue(restored)
        XCTAssertEqual(editor.text, draft)
        let restoredEditor = await composerTextView(in: window)
        XCTAssertTrue(restoredEditor === editor)
    }

    func testTabletopDisablesStripToggleAndPreservesTheFlatPreference() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let suite = "TAL-495-strip-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: ComposerVisibilitySettings.controlStripKey)
        let window = try hostWindow(FoldHost(content: AnyView(fixture.chat(session)),
            division: CGRect(x: -100, y: 330, width: 2000, height: 40))
            .defaultAppStorage(defaults), size: CGSize(width: 900, height: 900))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        try await typeIntoComposer("Retained control-strip preference", in: window)
        let loadedEditor = await composerTextView(in: window)
        try XCTUnwrap(loadedEditor).resignFirstResponder()
        settle(0.3)
        _ = try await requireElement(in: window, label: "Show composer controls")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        _ = try await requireElement(in: window, label: "Select model")
        let toggle = try await requireElement(in: window) {
            ["Show composer controls", "Hide composer controls"].contains($0.accessibilityLabel ?? "")
        }
        XCTAssertTrue(toggle.accessibilityTraits.contains(.notEnabled),
            "Tabletop must not offer an ineffective toggle that mutates the saved flat preference")
        XCTAssertEqual(toggle.accessibilityLabel, "Hide composer controls")
        XCTAssertFalse(defaults.bool(forKey: ComposerVisibilitySettings.controlStripKey))
        attachHostedScreenshot(window, name: "tabletop-strip-toggle-disabled")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let restored = try await requireElement(in: window, label: "Show composer controls")
        XCTAssertFalse(restored.accessibilityTraits.contains(.notEnabled))
        XCTAssertFalse(defaults.bool(forKey: ComposerVisibilitySettings.controlStripKey))
        HostedAccessibility.activate(restored)
        _ = try await requireElement(in: window, label: "Hide composer controls")
        XCTAssertTrue(defaults.bool(forKey: ComposerVisibilitySettings.controlStripKey))
    }

    func testBookFoldMovesTheClarificationCardAndItsChoices() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-clarification"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(FoldHost(content: AnyView(fixture.chat(session))),
                                    size: CGSize(width: 900, height: 700))
        _ = try await requireElement(in: window, label: "Clarification Required")
        settle(0.3)
        attachHostedScreenshot(window, name: "clarification-before-book-fold")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let choice = try await requireElement(in: window, label: "Use the deterministic path")
        let displaced = await awaitCondition { window.convert(choice.accessibilityFrame, from: nil).minX >= 470 }
        XCTAssertTrue(displaced, "The clarification choice still crosses the book fold")
        let header = try await requireElement(in: window, label: "Clarification Required")
        XCTAssertGreaterThanOrEqual(window.convert(header.accessibilityFrame, from: nil).minX, 470)
        XCTAssertGreaterThan(try transcriptScrollView(in: window).bounds.width, 800)
        settle(0.3)
        attachHostedScreenshot(window, name: "clarification-after-book-fold")
    }

    func testOffCenterBookFoldUsesThePhysicalTrailingRegionInRTL() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        // Both overlays request fixed physical frames, so RTL must choose the left pane.
        let recorder = ChatBodyEvaluationRecorder()
        let division = CGRect(x: 300, y: -100, width: 40, height: 2000)
        let chat = fixture.chat(session).environment(\.layoutDirection, .rightToLeft)
            .environment(\.chatBodyEvaluation, recorder)
        let window = try hostWindow(FoldHost(content: AnyView(chat),
            division: division),
            size: CGSize(width: 900, height: 700))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertFalse(recorder.transcriptFrame.isNull)
        // The injected division is chat-local; native vertical bars can move that origin in the window.
        let foldInWindow = division.offsetBy(dx: recorder.transcriptFrame.minX, dy: recorder.transcriptFrame.minY)
        try await typeIntoComposer("Retained RTL draft", in: window)
        let loadedEditor = await composerTextView(in: window)
        let editor = try XCTUnwrap(loadedEditor)
        XCTAssertGreaterThan(editor.convert(editor.bounds, to: window).maxX, foldInWindow.maxX)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let displaced = await awaitCondition { editor.convert(editor.bounds, to: window).maxX <= foldInWindow.minX }
        XCTAssertTrue(displaced, "The RTL composer must fit left of the physical division")
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertLessThanOrEqual(window.convert(send.accessibilityFrame, from: nil).maxX, foldInWindow.minX)
        XCTAssertEqual(editor.text, "Retained RTL draft")
        XCTAssertGreaterThan(try transcriptScrollView(in: window).bounds.width, 800)
        settle(0.3)
        attachHostedScreenshot(window, name: "composer-off-center-rtl-book-fold")
    }

    func testNativeReasoningRefusalIsVisibleWithoutChangingEffort() async throws {
        try await checkReasoningRefusal(scopeSupported: true)
    }

    func testOlderServerReasoningRefusalIsVisibleWithoutAnyWrite() async throws {
        try await checkReasoningRefusal(scopeSupported: false)
    }

    private func checkReasoningRefusal(scopeSupported: Bool) async throws {
        let fixture = try FixtureApp(for: self)
        let summary = SessionSummary(sessionId: "session-abc", title: "Native reasoning")
        let session = UITestFixtureURLProtocol.diagnosticSession([
            "session_id": "session-abc",
            "messages": [["role": "user", "content": "Continue the native conversation", "message_id": "native-user"]]
        ], mode: "normal")
        let sessionJSON = String(decoding: try JSONSerialization.data(withJSONObject: ["session": session]), as: UTF8.self)
        let refusal = scopeSupported
            ? "Reasoning changes are unavailable for this conversation"
            : "Update the server to change reasoning safely for a conversation."
        let evidenceName = scopeSupported ? "native-reasoning" : "legacy-reasoning"
        var effortRequests = 0
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient(), sessionSummary: summary) { request in
            switch request.url?.path {
            case "/api/session": return apiTestJSONResponse(sessionJSON, for: request)
            case "/api/reasoning" where request.httpMethod == "POST":
                effortRequests += 1
                XCTAssertEqual(try apiTestJSONBody(from: request)["session_id"] as? String, "session-abc")
                if !scopeSupported { return apiTestJSONResponse(#"{"reasoning_effort":"high"}"#, for: request) }
                return apiTestJSONResponse(#"{"error":"\#(refusal)","code":"reasoning_unsupported"}"#, statusCode: 409, for: request)
            case "/api/reasoning": return apiTestJSONResponse(scopeSupported
                ? #"{"reasoning_effort":"medium","supports_session_scope":true}"#
                : #"{"reasoning_effort":"medium"}"#, for: request)
            default: return apiTestJSONResponse("{}", for: request)
            }
        }
        defer {
            viewModel.cleanupPollingTasks()
            MockURLProtocol.requestHandler = nil
        }
        await viewModel.loadMessages()
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: UITestFixtureEnvironment.serverURL, onAPIError: { _ in },
                     loadsInitialMessages: false, viewModel: viewModel)
        }.modelContainer(fixture.cache), size: HostedSize.phone)
        _ = try await requireElement(in: window, label: "Native reasoning")
        _ = try await requireElement(in: window, label: "Select model")
        let configured = await awaitCondition { viewModel.selectedReasoningEffort == "medium" }
        XCTAssertTrue(configured)
        let initialEffort = viewModel.selectedReasoningEffort
        settle(0.5)
        attachHostedScreenshot(window, name: "\(evidenceName)-before")
        _ = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "reasoning")), args: "high")
        let refusalElement = await awaitElement(in: window) { $0.accessibilityLabel?.contains(refusal) == true }
        XCTAssertNotNil(refusalElement)
        XCTAssertEqual(viewModel.selectedReasoningEffort, initialEffort)
        XCTAssertEqual(effortRequests, scopeSupported ? 1 : 0)
        settle(0.5)
        attachHostedScreenshot(window, name: "\(evidenceName)-after")
    }

    func testRevealTicksOnlyEvaluateTheMessageList() async throws {
        try await checkRevealTickIsolation(size: CGSize(width: 320, height: 844), name: "phone")
    }

    func testRevealTicksOnlyEvaluateTheMessageListOnPad() async throws {
        try await checkRevealTickIsolation(size: HostedSize.padLandscape, name: "pad")
    }

    private func checkRevealTickIsolation(size: CGSize, name: String) async throws {
        let fixture = try FixtureApp(for: self)
        let stream = ScriptedSSEStreamingClient()
        let summary = SessionSummary(sessionId: "session-abc", title: "Streaming isolation")
        let viewModel = try makeScriptedChatViewModel(streamClient: stream, flushesEachEvent: false,
            streamingScrollCoalescingDelayNanoseconds: 60_000_000_000, sessionSummary: summary,
            server: UITestFixtureEnvironment.serverURL) { request in
            if request.url?.path == "/api/chat/start" {
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-isolation"}"#, for: request)
            }
            if request.url?.path == "/api/session/yolo" {
                return apiTestJSONResponse(#"{"yolo_enabled":true}"#, for: request)
            }
            return apiTestJSONResponse("{}", for: request)
        }
        stream.flushPendingStreamingContent = { [weak viewModel] in viewModel?.revealStreamingContentTickForTesting() }
        defer {
            viewModel.suspendStreamForNavigation()
            viewModel.cleanupPollingTasks()
            MockURLProtocol.requestHandler = nil
            stream.stop()
            ChatViewModel.resetActiveStreamSnapshotsForTesting()
        }
        let evaluations = ChatBodyEvaluationRecorder()
        let window = try hostWindow(NavigationStack {
            fixture.chat(summary, viewModel: viewModel, asNavigationDestination: false,
                         initialDraft: "Keep this draft", loadsInitialMessages: false)
        }.environment(\.chatBodyEvaluation, evaluations), size: size)
        let configured = await awaitCondition { viewModel.isSessionApprovalBypassEnabled }
        XCTAssertTrue(configured, "The hosted chat's startup must finish before measuring reveal work")
        let started = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(started)
        stream.emit(.token("Opening "))
        let opened = await awaitCondition { viewModel.messages.last?.content == "Opening " }
        XCTAssertTrue(opened)
        // Count only reveal work: wait until the send's own updates (stream start, the status chip's measured
        // height) have rendered. A fixed delay let a late layout pass on a loaded CI runner land in the window.
        await awaitQuietWork(of: evaluations, phase: "Post-send settle before measuring reveal work")
        // Snapshot capture can enqueue layout updates. Keep its diagnostics after
        // the measured reveal window so those updates aren't counted as reveal work.
        evaluations.reset()
        var expected = "Opening "
        for tick in 1...20 {
            let token = "word\(tick) "
            expected += token
            stream.emit(.token(token))
            let revealed = await awaitCondition { viewModel.messages.last?.content == expected }
            XCTAssertTrue(revealed, "Reveal tick \(tick) never reached the transcript")
            let rendered = await awaitRenderedQuiet(in: window) { evaluations.counts.values.reduce(0, +) }
            XCTAssertTrue(rendered, "Reveal tick \(tick) kept re-evaluating")
        }
        let measured = evaluations.counts
        let counts = XCTAttachment(string: "20 reveal ticks: \(measured)")
        counts.name = "body-evaluations-\(name)"
        counts.lifetime = .keepAlways
        add(counts)
        XCTAssertEqual(measured["messages", default: 0], 20, "Each reveal must evaluate the message list once")
        XCTAssertLessThanOrEqual(measured["composer", default: 0], 1, "Reveal ticks rebuilt the composer")
        XCTAssertEqual(measured["chat", default: 0], 0, "Reveal ticks rebuilt the whole chat")
        let composer = await composerTextView(in: window)
        XCTAssertEqual(composer?.text, "Keep this draft")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Send"))
        attachHostedScreenshot(window, name: "stream-isolation-after-ticks-\(name)")
    }

    func testOwnerModelConfirmationDisplaysTheServersMessage() async throws {
        let fixture = try FixtureApp(for: self)
        let stream = ScriptedSSEStreamingClient()
        let summary = SessionSummary(sessionId: "session-abc", title: "Owner model confirmation", model: "old-model")
        let viewModel = try makeScriptedChatViewModel(streamClient: stream, sessionSummary: summary) { request in
            if request.url?.path == "/api/session" {
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","title":"Owner model confirmation","model":"old-model","read_only":true,"owner_attachment":{"state":"attached","can_submit":true,"can_interrupt":false,"can_attach":false,"revision":3,"execution_generation":1,"admissions":[],"model_change":{"state":"confirmation_required","confirm":"owner-token","model":"picked-model","provider":"custom","message":"Confirm the owner's model change"}},"messages":[]}}"#, for: request)
            }
            return apiTestJSONResponse("{}", for: request)
        }
        defer {
            viewModel.suspendStreamForNavigation()
            viewModel.cleanupPollingTasks()
            MockURLProtocol.requestHandler = nil
            stream.stop()
        }
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.modelSwitchConfirmation?.message, "Confirm the owner's model change")
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary,
                server: URL(string: "https://example.test")!, onAPIError: { _ in },
                loadsInitialMessages: false, viewModel: viewModel)
        }.modelContainer(fixture.cache))
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented)
        XCTAssertEqual(alert.message, "Confirm the owner's model change")
        attachHostedScreenshot(window, name: "owner-model-confirmation-message")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: alert))
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed)
        XCTAssertNil(viewModel.modelSwitchConfirmation)
        XCTAssertEqual(viewModel.selectedModelID, "old-model")
    }

    func testModelGuardCancelRefreshAndConfirmUseServerWarnings() async throws {
        try await checkModelGuardWarnings(refusalCount: 3)
    }

    func testModelGuardRepeatedRefusalsPresentEveryServerWarning() async throws {
        try await checkModelGuardWarnings(refusalCount: 30)
    }

    private func checkModelGuardWarnings(refusalCount: Int) async throws {
        let fixture = try FixtureApp(for: self)
        let stream = ScriptedSSEStreamingClient()
        var updates = 0
        let viewModel = try makeScriptedChatViewModel(streamClient: stream, sessionSummary: SessionSummary(sessionId: "session-abc", title: "Model confirmation", model: "old-model", modelProvider: "custom")) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","title":"Model confirmation","model":"old-model","model_provider":"custom","messages":[]}}"#, for: request)
            case "/api/models":
                return apiTestJSONResponse(#"{"groups":[{"provider":"Test provider","provider_id":"custom","models":[{"id":"contributor","label":"Contributor"}]}]}"#, for: request)
            case "/api/session/update":
                updates += 1
                if updates == refusalCount + 1 {
                    XCTAssertEqual(try apiTestJSONBody(from: request)["confirm_token"] as? String, "token-\(refusalCount)")
                    return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","model":"contributor","model_provider":"custom"}}"#, for: request)
                }
                let title = updates >= 3 ? (updates == 3 ? "Context changed" : "Context changed \(updates)") : "Data policy"
                let message = updates >= 3 ? "The next reply will reread the updated context." : "This model may use your conversation for training."
                let body: [String: Any] = ["error": "Confirm model change", "type": "model_confirmation_required", "confirm_token": "token-\(updates)",
                    "warnings": [["kind": updates >= 3 ? "context_cache" : "data_policy", "title": title, "message": message, "model": "contributor", "provider": "custom"]]]
                return (HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!, try JSONSerialization.data(withJSONObject: body))
            default: return apiTestJSONResponse("{}", for: request)
            }
        }
        defer { MockURLProtocol.requestHandler = nil; stream.stop() }
        await viewModel.loadMessages()
        let window = try hostWindow(NavigationStack {
            ChatView(session: SessionSummary(sessionId: "session-abc", title: "Model confirmation"), server: URL(string: "https://example.test")!,
                     onAPIError: { _ in }, loadsInitialMessages: false, viewModel: viewModel)
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
        settle(0.5)
        attachHostedScreenshot(window, name: "model-before")
        _ = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "model")), args: "contributor")
        let firstAlert = await presentedAlert(in: window)
        let first = try XCTUnwrap(firstAlert)
        XCTAssertEqual(first.title, "Change Model?")
        XCTAssertEqual(first.message, "Data policy\n\nThis model may use your conversation for training.")
        XCTAssertEqual(viewModel.selectedModelID, "old-model")
        settle(0.4)
        attachHostedScreenshot(window, name: "model-warning")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: first))
        let cancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(cancelled)
        XCTAssertEqual(updates, 1)
        XCTAssertEqual(viewModel.selectedModelID, "old-model")
        settle(0.4)
        attachHostedScreenshot(window, name: "model-cancelled")
        _ = await viewModel.selectComposerModel(ModelCatalogOption(id: "contributor", displayName: "Contributor", providerID: "custom"))
        let secondAlert = await presentedAlert(in: window)
        var currentAlert = try XCTUnwrap(secondAlert)
        for update in 3...refusalCount {
            XCTAssertTrue(HostedAccessibility.tap("Change Model", in: currentAlert))
            let refreshed = await awaitCondition { viewModel.modelSwitchConfirmation?.confirmToken == "token-\(update)" }
            XCTAssertTrue(refreshed, "The server's warning \(update) never reached the model")
            let title = update == 3 ? "Context changed" : "Context changed \(update)"
            let message = "\(title)\n\nThe next reply will reread the updated context."
            // The previous alert is still leaving; its replacement can take a tap once it has finished presenting.
            var refreshedAlert: UIAlertController?
            _ = await awaitCondition {
                var top = window.rootViewController
                while let presented = top?.presentedViewController { top = presented }
                refreshedAlert = top as? UIAlertController
                return refreshedAlert?.message == message && refreshedAlert?.isBeingPresented == false
            }
            let warning = try XCTUnwrap(refreshedAlert, "The server's warning \(update) never appeared")
            XCTAssertEqual(warning.message, message)
            XCTAssertEqual(viewModel.selectedModelID, "old-model")
            if update == 3 { attachHostedScreenshot(window, name: "model-refreshed") }
            currentAlert = warning
        }
        XCTAssertTrue(HostedAccessibility.tap("Change Model", in: currentAlert))
        let applied = await awaitCondition { viewModel.selectedModelID == "contributor" }
        XCTAssertTrue(applied)
        XCTAssertEqual(updates, refusalCount + 1)
        settle(0.3)
        attachHostedScreenshot(window, name: "model-confirmed")
    }

    func testStreamingSendConsumesDraftWhileSteerIsHeldAndPreservesNewTyping() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-controls", "--ui-test-hold-steer"], for: self)
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("Held steering prompt", in: window)
        _ = try await requireElement(in: window, label: "Held steering prompt")
        let composer = await composerTextView(in: window)
        let draft = try XCTUnwrap(composer)
        XCTAssertEqual(draft.text, "", "A streaming send must consume its draft before the steer answers")
        attachHostedScreenshot(window, name: "streaming-send-pending-phone")
        try await typeIntoComposer("Newer draft", in: window)
        fixture.releaseHeldLoads()
        let waiting = await awaitElement(in: window, label: "Held steering prompt")
        XCTAssertNotNil(waiting)
        XCTAssertEqual(draft.text, "Newer draft")
    }

    func testForegroundReturnRealizesZeroUnchangedTranscriptRows() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let model = ChatViewModel(
            session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
            liveActivityManager: SpyChatLiveActivityManager()
        )
        let retained = RetainedChat(viewModel: model, session: session)
        let window = try hostWindow(NavigationStack {
            ChatView(session: session, server: UITestFixtureEnvironment.serverURL, onAPIError: { _ in },
                draftStore: fixture.environment.draftStore, retained: retained)
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let observer = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self))
        let idle = await awaitCondition { observer.coordinator?.scrollPositionController?.isRealizingRows == false }
        XCTAssertTrue(idle)
        let settled = await awaitQuietRowRealization(retained.rows)
        let before = try XCTUnwrap(settled, "Transcript row realization must be quiet before the foreground sync")
        let beforeFrame = try await requireElement(in: window, label: "Fixture link request").accessibilityFrame
        let reads = UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/session" }.count }
        NotificationCenter.default.post(name: .talariaReturnedToForeground, object: nil)
        let reloaded = await awaitCondition {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/session" }.count } > reads
                && !model.isLoading
        }
        XCTAssertTrue(reloaded, "The foreground sync must finish before measuring row realization")
        settle(0.5)
        XCTAssertEqual(retained.rows.realizationCount - before, 0, "Unchanged foreground sync reconstructed transcript rows")
        let afterFrame = try await requireElement(in: window, label: "Fixture link request").accessibilityFrame
        XCTAssertEqual(afterFrame, beforeFrame, "The unchanged row moved after foreground sync")
    }

    func testCachedReopenKeepsLatestContentStationaryWhenSyncFinishes() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdTranscriptReloadsArgument], for: self)
        let response = try await fixture.client.session(id: UITestFixtureURLProtocol.sessionID)
        let messages = try XCTUnwrap(response.session?.messages)
        try CacheStore.cacheMessages(
            messages, serverURL: UITestFixtureEnvironment.serverURL,
            sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext,
            messagesOffset: 0, hasOlderMessages: false
        )

        let reopened = try hostWindow(fixture.sessionList(), size: CGSize(width: 402, height: 874), animationsEnabled: true)
        try await openSidebar(in: reopened)
        let row = try await requireElement(in: reopened) { $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true }
        XCTAssertTrue(HostedAccessibility.activate(row))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server")
        settle(0.5)
        let scroll = try transcriptScrollView(in: reopened)
        let beforeOffset = scroll.contentOffset.y
        let beforeHeight = scroll.contentSize.height
        let beforeInset = scroll.adjustedContentInset.bottom
        let anchor = try await requireElement(in: reopened, label: "Fixture link request")
        let beforeAnchorY = anchor.accessibilityFrame.minY
        attachHostedScreenshot(reopened, name: "cached-reopen-syncing-bottom")

        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced)
        settle(0.5)
        attachHostedScreenshot(reopened, name: "cached-reopen-after-sync")
        let afterAnchor = try await requireElement(in: reopened, label: "Fixture link request")
        let metrics = XCTAttachment(string: "offset: \(beforeOffset) -> \(scroll.contentOffset.y); height: \(beforeHeight) -> \(scroll.contentSize.height); bottom inset: \(beforeInset) -> \(scroll.adjustedContentInset.bottom); anchor Y: \(beforeAnchorY) -> \(afterAnchor.accessibilityFrame.minY)")
        metrics.name = "cache reopen scroll metrics"
        metrics.lifetime = .keepAlways
        add(metrics)
        XCTAssertEqual(afterAnchor.accessibilityFrame.minY, beforeAnchorY, accuracy: 3, "Sync completion moved an unchanged message on screen")
    }

    func testSyncingBesideGoalDoesNotReserveTranscriptSpaceInNarrowStack() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads", "--ui-test-goal"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(fixture.chat(session), size: CGSize(width: 320, height: 844))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Goal parked") == true }
        NotificationCenter.default.post(name: .talariaReauthenticated, object: UITestFixtureEnvironment.serverURL)
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        settle(0.3)
        let scroll = try transcriptScrollView(in: window)
        let withSyncing = scroll.adjustedContentInset.bottom
        fixture.releaseHeldLoads()
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(cleared)
        settle(0.3)
        XCTAssertEqual(scroll.adjustedContentInset.bottom, withSyncing, accuracy: 1,
                       "The non-reserving syncing segment changed the transcript inset beside a goal")
    }

    func testWorkingAndQueueShareOneRowWithIndependentActions() async throws {
        continueAfterFailure = false
        let window = try await hostChatWithTwoQueuedMessages()
        let queue = try await requireElement(in: window, label: "2 queued")
        let status = try await requireElement(in: window) { $0.accessibilityLabel?.hasSuffix("is working on the response") == true }
        settle(0.3)
        attachHostedScreenshot(window, name: "working-queue-phone")
        XCTAssertEqual(status.accessibilityFrame.midY, queue.accessibilityFrame.midY, accuracy: 1,
                       "Working and the queue must be segments of one row")
        XCTAssertLessThan(status.accessibilityFrame.maxX, queue.accessibilityFrame.minX)
        XCTAssertFalse(status.accessibilityTraits.contains(.button))
        XCTAssertTrue(queue.accessibilityTraits.contains(.button))
        XCTAssertGreaterThanOrEqual(queue.accessibilityFrame.height, 44)
        HostedAccessibility.activate(status)
        XCTAssertNil(window.rootViewController?.presentedViewController)
        HostedAccessibility.activate(queue)
        _ = try await requireElement(in: window, label: "First queued message")
        _ = try await requireElement(in: window, label: "Second queued message")
    }

    private func hostChatWithTwoQueuedMessages() async throws -> UIWindow {
        let window = try await hostFixtureChat(["--ui-test-chat-controls"])
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("/queue First queued message", in: window)
        try await sendFromComposer("/queue Second queued message", in: window)
        return window
    }

    /// Removing queued messages drains the row's queue segment and leaves the run working; a new message queues again.
    func testRemovingEveryQueuedMessageLeavesTheRunWorking() async throws {
        continueAfterFailure = false
        let window = try await hostChatWithTwoQueuedMessages()
        HostedAccessibility.activate(try await requireElement(in: window, label: "2 queued"))
        _ = try await requireElement(in: window, label: "First queued message")
        _ = try await requireElement(in: window, label: "Second queued message")
        for remaining in [1, 0] {
            let remove = try XCTUnwrap(elements(named: "Remove", in: window).first {
                $0.accessibilityTraits.contains(.button) && $0.accessibilityFrame.height > 0
                    && window.bounds.contains(window.convert($0.accessibilityFrame, from: nil))
            }, "The queue has no visible Remove button")
            XCTAssertTrue(HostedAccessibility.activate(remove))
            if remaining == 1 {
                // List retains removed rows in its hosted AX cache. Observe the live count and
                // reopen the sheet before targeting its remaining row.
                _ = try await requireElement(in: window, label: "1 queued")
                HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
            }
            let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
            XCTAssertTrue(closed)
            if remaining == 1 {
                HostedAccessibility.activate(try await requireElement(in: window, label: "1 queued"))
                _ = try await requireElement(in: window, label: "Second queued message")
            }
        }
        let drained = await awaitNoElement(in: window) { $0.accessibilityLabel == "1 queued" || $0.accessibilityLabel == "2 queued" }
        XCTAssertTrue(drained)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasSuffix("is working on the response") == true }
        try await sendFromComposer("/queue Re-added message", in: window)
        _ = try await requireElement(in: window, label: "1 queued")
    }

    /// Server-rewritten media renders inside the Markdown around it, audio follows as a tile, and its Export opens the
    /// file exporter (TAL-186). Saving through the exporter is the phone check's.
    func testServerMediaRendersInsideTheMarkdownAroundIt() async throws {
        let window = try await hostFixtureChat(["--ui-test-transcript-media"])
        _ = try await requireElement(in: window, label: "Linked chart", "The linked image did not render as a thumbnail")
        // Thumbnails show a spinner until their bytes load, then the image in its 132-point box or, on failure, a
        // shorter unavailable chip under the same alt-text name.
        // Every spinner counts, the audio tile's too, and a hosted CI simulator can take well over 10 s to start audio.
        let loaded = await awaitCondition(timeout: 30) { !window.containsView(ofType: UIActivityIndicatorView.self) }
        XCTAssertTrue(loaded, "The thumbnails never finished loading")
        for name in ["Linked chart", "chart.png", "Chart"] {
            let thumbnail = try XCTUnwrap(elements(named: name, in: window).first, "Missing the \(name) thumbnail")
            XCTAssertEqual(thumbnail.accessibilityFrame.height, 132, accuracy: 1, "The \(name) thumbnail shows no image")
        }
        let labels = HostedAccessibility.labels(in: window)
        XCTAssertTrue(labels.contains { $0.contains("narration.mp3") }, "The audio file did not render as a tile")
        XCTAssertFalse(labels.contains { $0.contains("**") }, "Bold text around an image rendered literally")
        XCTAssertFalse(labels.contains { $0.contains("MEDIA:") }, "A media token rendered as text")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Export audio narration.mp3"))
        let exporter = await presentedController(in: window)
        XCTAssertTrue(exporter is UIDocumentPickerViewController, "The audio's Export did not open the file exporter")
        exporter?.dismiss(animated: false)
    }

    /// Very long bodies open collapsed to the server's excerpts and expand and collapse in place (TAL-456).
    func testHistoryInsertionKeepsRenderedReaderStillInTheFullChat() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: false)
    }

    func testHistoryInsertionKeepsExpandedReaderStillInTheFullChat() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true)
    }

    func testHistoryInsideALongTurnPreservesTheExpandedWorkAndReader() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true)
    }

    private func nativeHistoryDragDirectory() throws -> URL {
        let runtime = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".codex-tmp/xctest")
        guard let token = try? String(contentsOf: runtime.appendingPathComponent("native-history-drag"), encoding: .utf8),
              let runID = UUID(uuidString: token) else {
            throw XCTSkip("Use scripts/test-history-drag to supply real native gestures")
        }
        return runtime.appendingPathComponent("history-drag/\(runID.uuidString.lowercased())")
    }

    func testExpandedMessageSurvivesRecyclingItsRenderedBody() async throws {
        let state = RecycledBodyFixture()
        let window = try hostWindow(RecycledBodyView(state: state))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show more"))
        _ = try await requireElement(in: window, label: "Show less")
        state.showsBody = false
        let removed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Show less" }
        XCTAssertTrue(removed)
        state.showsBody = true
        let restored = await awaitElement(in: window, label: "Show less")
        XCTAssertNotNil(restored, "A recycled message must retain its expanded body")
    }

    func testFetchedToolOutputSurvivesRecyclingItsRenderedBody() async throws {
        var tool = ToolCall(id: "retained-tool", name: "fixture_tool", preview: "Clipped output", args: nil,
                            isCompleted: true, startedAt: 0)
        tool.resultTruncated = true
        let state = RecycledBodyFixture(tool: tool)
        defer { state.releaseToolResult() }
        let suite = "TalariaTests.retained-tool.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = try hostWindow(RecycledBodyView(state: state).defaultAppStorage(defaults))
        if let header = HostedAccessibility.elements(in: window).first(where: {
            $0.accessibilityHint == "Double tap to expand details."
        }) { HostedAccessibility.activate(header) }
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show full output"))
        let requested = await awaitCondition { state.isToolResultPending }
        XCTAssertTrue(requested)
        state.showsBody = false
        let loadingRemoved = await awaitNoElement(in: window) { $0.accessibilityLabel == "Loading…" }
        XCTAssertTrue(loadingRemoved)
        state.showsBody = true
        let loadingElement = await awaitElement(in: window, label: "Loading…")
        let loading = try XCTUnwrap(loadingElement, "Recycling must retain the expanded tool's in-flight fetch")
        XCTAssertTrue(loading.accessibilityTraits.contains(.notEnabled))
        state.releaseToolResult()
        _ = try await requireElement(in: window, label: "Full retained tool output")
        XCTAssertEqual(state.toolResultCalls, 1)
        state.showsBody = false
        let removed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Full retained tool output" }
        XCTAssertTrue(removed)
        state.showsBody = true
        let restored = await awaitElement(in: window, label: "Full retained tool output")
        XCTAssertNotNil(restored, "Recycling must retain the expanded tool's fetched output")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Show full output"))
    }

    /// TAL-2338: a row's whole-result fetch is the chat screen's read; leaving the screen cancels it, and the cancelled
    /// fetch shows neither its result nor a failure.
    func testLeavingTheChatCancelsAToolRowsFullResultFetch() async throws {
        var tool = ToolCall(id: "cancelled-tool", name: "fixture_tool", preview: "Clipped output", args: nil,
                            rawResult: "Clipped output", isCompleted: true, startedAt: 0)
        tool.resultTruncated = true
        let state = RecycledBodyFixture(tool: tool)
        defer { state.releaseToolResult() }
        let reads = ScreenReads()
        let window = try hostWindow(ToolCallCardView(toolCall: tool)
            .chatEnvironmentAction(\.chatFullToolResultLoader) { _ in { await state.toolResult() } }
            .environment(\.chatScreenReads, reads)
            .environment(\.chatTranscriptRowState, state.rowState))
        if let header = HostedAccessibility.elements(in: window).first(where: { $0.accessibilityHint == "Double tap to expand details." }) {
            HostedAccessibility.activate(header)
        }
        // Raw view fetches the whole result, as Show full output does.
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show raw"))
        let requested = await awaitCondition { state.isToolResultPending }
        XCTAssertTrue(requested)
        reads.cancelAll()
        state.releaseToolResult()
        let leaked = await awaitCondition(timeout: 2) {
            HostedAccessibility.element(in: window, label: "Full retained tool output") != nil
                || HostedAccessibility.element(in: window, label: "Retry") != nil
        }
        XCTAssertFalse(leaked, "A fetch the screen cancelled must not land in the row")
        _ = try await requireElement(in: window, label: "Show full output")
        XCTAssertEqual(state.toolResultCalls, 1)
    }

    /// TAL-2340: the row that started a background command shows the command's latest output line from Background Work
    /// while it runs; the line leaves when it ends. The running row beside it is for the screenshot; its elapsed time is
    /// owned by TalariaKit `ToolProgressTests`.
    func testBackgroundCommandRowShowsItsOutputLineUntilItEnds() async throws {
        var running = ToolCall(id: "test-run", name: "terminal", preview: nil, args: nil, kind: .shell, target: "npm test -- auth.spec.ts")
        running.timerStart = Date().timeIntervalSince1970 - 34
        let started = ToolCall(id: "dev-server", name: "terminal", preview: "Background process started", args: nil, kind: .shell, target: "npm run dev",
                               duration: 0.1, isCompleted: true, processID: "proc_dev0123456789")
        let tail = "✓ 41 passing · auth.spec.ts › refreshes an expired session"
        let rows = { (tails: [String: String]) in
            VStack(alignment: .leading, spacing: 0) {
                ToolCallCardView(toolCall: started)
                ToolCallCardView(toolCall: running)
                Spacer()
            }
            .padding(.horizontal, 16)
            .environment(\.chatProcessOutputTails, tails)
        }
        let window = try hostWindow(rows(["proc_dev0123456789": tail]))
        _ = try await requireElement(in: window, label: tail)
        attachHostedScreenshot(window, name: "TAL-2340 running row and background output line")
        let ended = try hostWindow(rows([:]))
        let gone = await awaitNoElement(in: ended) { $0.accessibilityLabel == tail }
        XCTAssertTrue(gone, "A process that ended has no output line")
    }

    /// Driven by scripts/test-history-drag; ordinary hosted runs have no external gesture driver.
    func testHistoryInsertionPreservesReaderDuringNativeDrag() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true, nativeDrag: true)
    }

    func testLargeLoadedHistoryInsertionPreservesReaderDuringNativeDrag() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true, nativeDrag: true, largeHistory: true)
    }

    func testHistoryInsertionPreservesNativeDeceleration() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true, nativeDrag: true, nativeFling: true)
    }

    private func assertFullChatHistoryInsertion(expandDisclosure: Bool, boundaryTurn: Bool = false, nativeDrag: Bool = false, largeHistory: Bool = false, nativeFling: Bool = false) async throws {
        let nativeRunDirectory = nativeDrag ? try nativeHistoryDragDirectory() : nil
        var scenario = [UITestFixtureEnvironment.historyPagingArgument,
                        UITestFixtureEnvironment.holdTranscriptReloadsArgument]
        if largeHistory { scenario.append(UITestFixtureEnvironment.largeHistoryWindowArgument) }
        let initialStart = largeHistory ? 1_000 : 1_950
        if boundaryTurn { scenario.append(UITestFixtureEnvironment.historyTurnBoundaryArgument) }
        else if expandDisclosure { scenario.append(UITestFixtureEnvironment.longPromptArgument) }
        let fixture = try FixtureApp(scenario, for: self)
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("History answer 1999.") == true }
        let scroll = try transcriptScrollView(in: window)
        let isVisible: (NSObject) -> Bool = { element in
            window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                .intersects(window.convert(element.accessibilityFrame, from: nil))
        }
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        let controller = try XCTUnwrap(coordinator.scrollPositionController)
        let entrySettled = await awaitCondition {
            !controller.isNavigating && !controller.isPreservingPosition && !controller.isRealizingRows
        }
        XCTAssertTrue(entrySettled, "Entry realization must settle before positioning the fixture reader")
        controller.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        let readerID = boundaryTurn ? "history-\(initialStart + 9)" : "history-1954"
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let initialPage = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(
            withJSONObject: UITestFixtureURLProtocol.historyMessages(from: initialStart, to: 2_000)))
        let readerRow = try XCTUnwrap(ChatViewModel.transcriptMessages(from: initialPage, messageOffset: initialStart)
            .first { $0.message.messageId == readerID })
        try await navigateTranscript(to: ChatTranscriptView.containerID(for: readerRow.renderID), anchor: boundaryTurn ? .top : .center, using: controller)
        let held = await awaitCondition { self.hasHeldHistoryPage(before: initialStart) }
        XCTAssertTrue(held, "The real view model must request its older page before measuring insertion")
        if expandDisclosure {
            if boundaryTurn {
                HostedAccessibility.activate(try await requireElement(in: window) {
                    $0.accessibilityLabel == "Worked" && $0.accessibilityHint == "Double tap to expand work."
                        && isVisible($0)
                })
                _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
            } else {
                HostedAccessibility.activate(try await requireElement(in: window) {
                    $0.accessibilityLabel == "Show more" && isVisible($0)
                })
                _ = try await requireElement(in: window, label: "Show less")
            }
            let settled = await awaitCondition { !controller.isHoldingPosition }
            XCTAssertTrue(settled)
        }
        // Let the layout the navigation and disclosure queued commit before choosing the reader's point.
        _ = await awaitRenderedQuiet(in: window) { [scroll.contentOffset.y, scroll.contentSize.height] }
        let reader: NSObject
        if boundaryTurn {
            reader = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
        } else if expandDisclosure {
            reader = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Fixture prompt line 1\n") == true }
        } else {
            reader = try await requireElement(in: window, label: "History prompt 1954.")
        }
        let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
        let frame = window.convert(reader.accessibilityFrame, from: nil).intersection(viewport)
        XCTAssertFalse(frame.isEmpty, "The reader must be visibly on screen before releasing the page")
        let point = CGPoint(x: frame.midX, y: frame.midY)
        let registry = try messageMenuRegistry(in: window)
        var before = try XCTUnwrap(registry.hit(at: scroll.convert(point, from: window), in: scroll))
        XCTAssertEqual(before.content.messageID, readerID)
        let renderedReader = try XCTUnwrap(window.firstView(ofType: ChatMessageInteractionMarkerView.self) {
            $0.bounds.size == before.rowSize
                && abs($0.convert(point, from: window).y - before.localPoint.y) < 0.5
        }, "Track the same rendered reader throughout insertion and native momentum")
        func readerGeometry() -> [String: Double] {
            let textFrame = window.convert(reader.accessibilityFrame, from: nil)
            let presentation = renderedReader.layer.presentation()
            let presentedY: CGFloat?
            if let presentation, let windowPresentation = window.layer.presentation() {
                presentedY = presentation.convert(presentation.bounds.origin, to: windowPresentation).y
            } else { presentedY = nil }
            return ["textY": Double(textFrame.minY), "textHeight": Double(textFrame.height),
                    "markerAttached": renderedReader.window === window ? 1 : 0,
                    "markerY": Double(renderedReader.convert(renderedReader.bounds.origin, to: window).y),
                    "markerLocalY": Double(renderedReader.convert(point, from: window).y),
                    "markerBoundsY": Double(renderedReader.bounds.minY),
                    "markerHeight": Double(renderedReader.bounds.height),
                    "markerTransformY": Double(renderedReader.transform.ty),
                    "markerScaleY": Double(renderedReader.transform.d),
                    "hasPresentation": presentedY == nil ? 0 : 1,
                    "presentationWindowY": Double(presentedY ?? renderedReader.convert(renderedReader.bounds.origin, to: window).y),
                    "presentationPositionY": Double(presentation?.position.y ?? renderedReader.layer.position.y),
                    "presentationBoundsY": Double(presentation?.bounds.minY ?? renderedReader.bounds.minY),
                    "presentationHeight": Double(presentation?.bounds.height ?? renderedReader.bounds.height)]
        }
        // A disclosure's rendered transition can outlive the position hold. Measure
        // insertion only after that motion stops, while the page is still held.
        var previousGeometry: [String: Double]?
        var stableReaderSamples = 0
        let readerSettled = await awaitCondition {
            let geometry = readerGeometry()
            stableReaderSamples = !controller.isHoldingPosition && geometry == previousGeometry
                ? stableReaderSamples + 1 : 0
            previousGeometry = geometry
            return stableReaderSamples >= 5
        }
        XCTAssertTrue(readerSettled, "The rendered reader must settle before releasing the older page")
        before = try XCTUnwrap(registry.hit(at: scroll.convert(point, from: window), in: scroll))
        XCTAssertEqual(before.content.messageID, readerID)
        var baselineGeometry = readerGeometry()
        baselineGeometry["hitHeight"] = Double(before.rowSize.height)
        baselineGeometry["hitLocalY"] = Double(before.localPoint.y)
        let baselineImage: UIImage?
        if nativeDrag { baselineImage = nil }
        else {
            baselineImage = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
            baselineGeometry["afterCaptureMarkerY"] = Double(renderedReader.convert(renderedReader.bounds.origin, to: window).y)
            baselineGeometry["afterCaptureTextY"] = Double(window.convert(reader.accessibilityFrame, from: nil).minY)
        }
        let oldHeight = scroll.contentSize.height
        let maximumFrameGapMilliseconds: Double = 100
        var samples: [[String: Double]] = []
        var largestMovement: CGFloat = 0
        var missingReader = false
        var previousTick = ProcessInfo.processInfo.systemUptime
        var initialTranslation: CGFloat?
        var dragSamples = 0
        var pageReleased = false
        var decelerationStarted: TimeInterval?
        var decelerationDuration: TimeInterval = 0
        var sawNativeFling = false
        var lostMomentumReader = false
        if let nativeRunDirectory {
            try FileManager.default.createDirectory(at: nativeRunDirectory, withIntermediateDirectories: true)
            try Data("ready".utf8).write(to: nativeRunDirectory.appendingPathComponent("ready"))
        }
        let updateLink = UIUpdateLink(windowScene: try XCTUnwrap(window.windowScene))
        updateLink.addAction(to: .afterUpdateComplete) { _, info in
            guard samples.count < (nativeFling ? 240 : 120) else { return }
            let now = ProcessInfo.processInfo.systemUptime
            let translation = scroll.panGestureRecognizer.translation(in: scroll).y
            // UIKit can keep isDragging true throughout deceleration. The pan's
            // actual touches distinguish a held finger from native momentum.
            let touchDragging = scroll.isDragging && scroll.panGestureRecognizer.numberOfTouches > 0
            var samplePoint = point
            if nativeDrag {
                if scroll.isDecelerating { sawNativeFling = true }
                if nativeFling, scroll.isDecelerating, !touchDragging {
                    if decelerationStarted == nil {
                        decelerationStarted = now
                    }
                    decelerationDuration = now - (decelerationStarted ?? now)
                }
                guard touchDragging || (nativeFling && sawNativeFling) else { return }
                if initialTranslation == nil {
                    // UIKit's translation already includes movement before the
                    // first display sample of a quick fling.
                    initialTranslation = 0
                    fixture.releaseHeldLoads()
                    pageReleased = true
                }
                samplePoint.y += translation - (initialTranslation ?? translation)
                if !nativeFling || touchDragging {
                    guard viewport.contains(samplePoint) else { return }
                    dragSamples += 1
                }
            }
            if nativeFling, renderedReader.window !== window { lostMomentumReader = true }
            let hit = registry.hit(at: scroll.convert(samplePoint, from: window), in: scroll)
            let delta = (hit?.localPoint.y ?? 0) - before.localPoint.y
            if !nativeFling || touchDragging {
                if hit?.content.messageID != before.content.messageID { missingReader = true }
                else { largestMovement = max(largestMovement, abs(delta)) }
            }
            samples.append(["gapMilliseconds": (now - previousTick) * 1_000,
                            "time": now,
                            "modelTime": info.modelTime,
                            "completionDeadline": info.completionDeadlineTime,
                            "readerY": Double(renderedReader.convert(.zero, to: window).y),
                            "readerDelta": Double(delta), "offset": Double(scroll.contentOffset.y),
                            "height": Double(scroll.contentSize.height), "translation": Double(translation),
                            "pointY": Double(samplePoint.y),
                            "dragging": scroll.isDragging ? 1 : 0,
                            "touchDragging": touchDragging ? 1 : 0,
                            "touchCount": Double(scroll.panGestureRecognizer.numberOfTouches),
                            "panState": Double(scroll.panGestureRecognizer.state.rawValue),
                            "tracking": scroll.isTracking ? 1 : 0,
                            "decelerating": scroll.isDecelerating ? 1 : 0,
                            "messageIndex": Double(Int(hit?.content.messageID.replacingOccurrences(of: "history-", with: "") ?? "") ?? -1)])
            if !nativeDrag {
                // Keep CI diagnostics out of the native gesture frame-budget measurement.
                var geometry = readerGeometry()
                geometry["hitHeight"] = Double(hit?.rowSize.height ?? -1)
                geometry["hitLocalY"] = Double(hit?.localPoint.y ?? -1)
                let markerPoint = renderedReader.convert(samplePoint, from: window)
                geometry["hitMatchesMarker"] = hit?.rowSize == renderedReader.bounds.size
                    && abs((hit?.localPoint.y ?? .infinity) - markerPoint.y) < 0.01 ? 1 : 0
                samples[samples.count - 1].merge(geometry) { _, new in new }
            }
            previousTick = now
        }
        updateLink.requiresContinuousUpdates = nativeDrag
        updateLink.isEnabled = true
        defer { updateLink.isEnabled = false }
        if nativeDrag {
            let started = await awaitCondition(timeout: 45) { pageReleased }
            XCTAssertTrue(started, "The reproduction requires a real native drag")
            try await Task.sleep(for: .seconds(3))
            XCTAssertGreaterThan(dragSamples, 3, "Sample the moving reader, not just its final position")
            let driverFinished = await awaitCondition(timeout: 15) {
                nativeRunDirectory.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("driver-finished").path) } ?? false
            }
            XCTAssertTrue(driverFinished, "The native driver must close before the simulator lease is released")
        } else {
            fixture.releaseHeldLoads()
            // Sample until the page has rendered and its one-second measurement window has ended.
            let inserted = await awaitCondition {
                scroll.contentSize.height > oldHeight + 500 && !controller.isPreservingPosition && !controller.isHoldingPosition
            }
            XCTAssertTrue(inserted, "The older page must render and its preservation window end")
        }
        XCTAssertGreaterThan(samples.count, 0, "The test must observe committed display frames")
        updateLink.isEnabled = false
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: false))
        let baselineData = try JSONSerialization.data(withJSONObject: baselineGeometry, options: [.prettyPrinted, .sortedKeys])
        let baselineAttachment = XCTAttachment(data: baselineData, uniformTypeIdentifier: "public.json")
        baselineAttachment.name = "History reader baseline geometry"
        baselineAttachment.lifetime = .keepAlways
        add(baselineAttachment)
        if let baselineImage {
            let image = XCTAttachment(image: baselineImage)
            image.name = "History reader before page response"
            image.lifetime = .keepAlways
            add(image)
        }
        let data = try JSONSerialization.data(withJSONObject: samples, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "Full chat history insertion frames"; attachment.lifetime = .keepAlways; add(attachment)
        attachHistoryImage(window, name: "Full chat after history insertion")
        XCTAssertGreaterThan(scroll.contentSize.height, oldHeight + 500, "The older page must actually render")
        XCTAssertFalse(missingReader, "Insertion must keep the same rendered message under the reader throughout layout")
        XCTAssertLessThanOrEqual(largestMovement, 2, "Insertion must not visibly jump before settling")
        if nativeDrag {
            let largestGap = samples.dropFirst().map { $0["gapMilliseconds"] ?? 0 }.max() ?? 0
            XCTAssertLessThanOrEqual(largestGap, maximumFrameGapMilliseconds, "History insertion must not stall the moving display")
            if nativeFling {
                XCTAssertTrue(sawNativeFling, "The native driver must produce a fling")
                XCTAssertFalse(lostMomentumReader, "Observe the rendered reader throughout momentum")
                XCTAssertGreaterThan(decelerationDuration, 0.3,
                                     "History arrival must preserve native momentum after the finger lifts")
                let coasting = samples.filter { $0["decelerating"] == 1 && $0["touchDragging"] == 0 }
                let travel = (coasting.last?["readerY"] ?? 0) - (coasting.first?["readerY"] ?? 0)
                XCTAssertGreaterThan(travel, 60, "The rendered content must keep coasting, not merely report deceleration")
                if var progress = coasting.first, let endingY = coasting.last?["readerY"] {
                    var longestPause: TimeInterval = 0
                    for sample in coasting.dropFirst() {
                        guard let y = sample["readerY"], let time = sample["time"],
                              y - (progress["readerY"] ?? y) > 0.5 else { continue }
                        if endingY - y > 60 {
                            longestPause = max(longestPause, time - (progress["time"] ?? time))
                        }
                        progress = sample
                    }
                    XCTAssertLessThanOrEqual(longestPause * 1_000, maximumFrameGapMilliseconds,
                                             "History realization must not freeze native momentum before a forward jump")
                }
                let released = samples.filter { $0["touchDragging"] == 0 }
                let reversals = zip(released, released.dropFirst()).map {
                    ($0["readerY"] ?? 0) - ($1["readerY"] ?? 0)
                }
                XCTAssertLessThanOrEqual(reversals.max() ?? 0, 2, "History measurement must not pull a coasting reader backward")
                if let last = coasting.last, let time = last["time"],
                   let tail = coasting.last(where: { ($0["time"] ?? time) < time - 0.05 }),
                   let tailTime = tail["time"] {
                    let speed = abs((last["readerY"] ?? 0) - (tail["readerY"] ?? 0)) / (time - tailTime)
                    XCTAssertLessThan(speed, 40, "Momentum must slow naturally before stopping")
                }
                XCTAssertEqual(samples.last?["decelerating"], 0, "Observe the fling through its natural end")
                return
            }
        }
        if expandDisclosure {
            if boundaryTurn {
                XCTAssertNotNil(HostedAccessibility.elements(in: window).first {
                    $0.accessibilityLabel == "Worked" && $0.accessibilityHint == "Double tap to collapse work."
                }, "Paging inside a turn must retain its expanded work")
                // Recycle the actual rich row, then return to its stable native target.
                // Its disclosure belongs to the row slot, not the removed view body.
                let latestRow = try XCTUnwrap(ChatViewModel.transcriptMessages(from: initialPage, messageOffset: initialStart).last)
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: latestRow.renderID), anchor: .bottom, using: controller)
                let recycled = await awaitNoElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
                XCTAssertTrue(recycled, "The expanded row must actually leave realization before revisiting it")
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: readerRow.renderID), anchor: .top, using: controller)
                _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
                // Start another page after moving away and back: the window now
                // contains retained heights and state from the first prepend.
                let previousStart = initialStart - 50
                let previousPage = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(
                    withJSONObject: UITestFixtureURLProtocol.historyMessages(from: previousStart, to: initialStart)))
                let nextReaderID = "history-\(previousStart + 1)"
                let nextReaderRow = try XCTUnwrap(ChatViewModel.transcriptMessages(from: previousPage, messageOffset: previousStart)
                    .first { $0.message.messageId == nextReaderID })
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: nextReaderRow.renderID), anchor: .top, using: controller)
                _ = try await requireElement(in: window) {
                    $0.accessibilityLabel?.hasPrefix("History answer \(previousStart + 1).") == true
                }
                let secondHeld = await awaitCondition { self.hasHeldHistoryPage(before: previousStart) }
                XCTAssertTrue(secondHeld, "Revisiting the prefix must request a second older page")
                _ = await awaitRenderedQuiet(in: window) { [scroll.contentOffset.y, scroll.contentSize.height] }
                // A tall answer's first paragraph can be above the viewport;
                // measure an actually visible piece of that same message.
                let nextPoint = try XCTUnwrap(stride(from: viewport.minY + 80, to: viewport.maxY - 80, by: 10)
                    .map { CGPoint(x: viewport.midX, y: $0) }
                    .first { registry.hit(at: scroll.convert($0, from: window), in: scroll)?.content.messageID == nextReaderID })
                let nextBefore = try XCTUnwrap(registry.hit(at: scroll.convert(nextPoint, from: window), in: scroll))
                XCTAssertEqual(nextBefore.content.messageID, nextReaderID)
                let secondOldHeight = scroll.contentSize.height
                fixture.releaseHeldLoads()
                let secondInserted = await awaitCondition {
                    scroll.contentSize.height > secondOldHeight && !controller.isPreservingPosition && !controller.isHoldingPosition
                }
                XCTAssertTrue(secondInserted, "The second older page must render and its preservation window end")
                // On a busy runner the page's last layout can land after the window; a reader it moved stays moved.
                _ = await awaitCondition {
                    guard let hit = registry.hit(at: scroll.convert(nextPoint, from: window), in: scroll) else { return false }
                    return abs(hit.localPoint.y - nextBefore.localPoint.y) <= 2
                }
                let nextAfter = try XCTUnwrap(registry.hit(at: scroll.convert(nextPoint, from: window), in: scroll))
                XCTAssertEqual(nextAfter.content.messageID, nextReaderID)
                XCTAssertEqual(nextAfter.localPoint.y, nextBefore.localPoint.y, accuracy: 2,
                               "A second prepend must preserve the revisited reader")
            } else {
                XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Show less"),
                                "A page must preserve the expanded disclosure state")
            }
        }
    }

    func testLongBodiesOpenCollapsedAndExpandInPlace() async throws {
        let window = try await hostFixtureChat(["--ui-test-long-bodies"])
        // Lazy layout exposes controls only near the viewport. Exercise the
        // actual route to the end of a 100k-character expanded body.
        for cycle in 1...3 {
            _ = try await requireElement(in: window, label: "Short reply 25.")
            let scroll = try transcriptScrollView(in: window)
            let controller = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator?.scrollPositionController)
            var previousTailFrame: CGRect?
            var stableEntrySamples = 0
            let entered = await awaitCondition {
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                guard !controller.isHoldingPosition,
                      let tail = self.elements(named: "Short reply 25.", in: window).first(where: {
                          viewport.intersects(window.convert($0.accessibilityFrame, from: nil))
                      }) else { stableEntrySamples = 0; return false }
                let frame = window.convert(tail.accessibilityFrame, from: nil)
                stableEntrySamples = frame == previousTailFrame ? stableEntrySamples + 1 : 0
                previousTailFrame = frame
                return stableEntrySamples >= 5
            }
            XCTAssertTrue(entered, "The latest row must finish entry before toggling the last body")
            let latestDisclosure = await awaitElement(in: window) { element in
                guard element.accessibilityLabel == "Show more" else { return false }
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                return viewport.intersects(window.convert(element.accessibilityFrame, from: nil))
                    && (try? self.messageMenuHit(at: element, in: window)?.content.messageID) == "long-body-user-48"
            }
            let showMore = try XCTUnwrap(latestDisclosure, "The last 100k-character body must be visible at entry")
            XCTAssertEqual(try messageMenuTarget(at: showMore, in: window), .control, "A long press on Show more opens the message menu")
            let controlFrame = window.convert(showMore.accessibilityFrame, from: nil)
            let readerPoint = CGPoint(x: controlFrame.midX, y: controlFrame.midY)
            let beforeHit = try XCTUnwrap(messageMenuHit(at: readerPoint, in: window))
            let beforeHeight = beforeHit.rowSize.height
            HostedAccessibility.activate(showMore)
            let expanded = await awaitCondition {
                guard let hit = try? self.messageMenuHit(at: readerPoint, in: window), hit.content.messageID == beforeHit.content.messageID else { return false }
                return hit.rowSize.height > beforeHeight + 1_000
            }
            XCTAssertTrue(expanded, "Cycle \(cycle): the full body must expand beyond its excerpt")
            let settled = await awaitCondition { !controller.isHoldingPosition }
            XCTAssertTrue(settled)
            attachHistoryImage(window, name: "Expansion layout, cycle \(cycle)")
            let afterHit = try XCTUnwrap(messageMenuHit(at: readerPoint, in: window), "Expansion left no message under the reader; offset=\(scroll.contentOffset.y), height=\(scroll.contentSize.height), point=\(readerPoint)")
            XCTAssertEqual(afterHit.content.messageID, beforeHit.content.messageID)
            XCTAssertEqual(afterHit.localPoint.y, beforeHit.localPoint.y, accuracy: 2, "Cycle \(cycle): expansion moved the visible body")
            let expandedHeight = afterHit.rowSize.height
            attachHistoryImage(window, name: "Expanded large body, cycle \(cycle)")
            // The collapse control follows the full body; reach it as a user does.
            let jump = try await requireElement(in: window, label: "Scroll to latest message")
            XCTAssertTrue(HostedAccessibility.activate(jump))
            let visibleCollapse = await awaitElement(in: window) { element in
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                return element.accessibilityLabel == "Show less"
                    && viewport.intersects(window.convert(element.accessibilityFrame, from: nil))
            }
            let showLess = try XCTUnwrap(visibleCollapse, "The collapse control must become visible after native scrolling")
            HostedAccessibility.activate(showLess)
            let collapsed = await awaitCondition {
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                return self.elements(named: "Show more", in: window).contains { element in
                    guard viewport.intersects(window.convert(element.accessibilityFrame, from: nil)),
                          let hit = try? self.messageMenuHit(at: element, in: window),
                          hit.content.messageID == beforeHit.content.messageID else { return false }
                    return hit.rowSize.height < expandedHeight - 1_000 && abs(hit.rowSize.height - beforeHeight) <= 2
                }
            }
            XCTAssertTrue(collapsed, "The expanded body did not collapse again")
            let removed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Show less" }
            XCTAssertTrue(removed)
        }
        recordPeakResidentMemory("original-long-user-bodies")
        // An unfocused composer is its collapsed "Message" shell.
        let composer = await awaitElement(in: window, label: "Message")
        XCTAssertNotNil(composer, "The composer went away")
    }

    func testAssistantHistoryWithOneFullNewestMarkdownReply() async throws {
        try await checkAssistantHistory(collapseNewest: false)
    }

    func testAssistantHistoryWithAllBodiesCollapsedMemoryBaseline() async throws {
        try await checkAssistantHistory(collapseNewest: true)
    }

    private func checkAssistantHistory(collapseNewest: Bool) async throws {
        let scenario = ["--ui-test-long-bodies", "--ui-test-assistant-long-bodies"] + (collapseNewest ? ["--ui-test-collapse-newest-body"] : [])
        let fixture = try FixtureApp(scenario, for: self)
        let response = try await fixture.client.session(id: UITestFixtureURLProtocol.sessionID)
        let messages = try XCTUnwrap(response.session?.messages)
        let assistants = messages.filter { $0.role == "assistant" }
        XCTAssertEqual(assistants.count, 25)
        XCTAssertEqual(assistants.filter { $0.displayExcerpt != nil }.count, collapseNewest ? 25 : 24)
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        _ = try await requireElement(in: window, where: { $0.accessibilityLabel?.contains("Long fixture body 25") == true })
        attachHostedScreenshot(window, name: collapseNewest ? "assistant-history-collapsed" : "assistant-history-newest-full")
        recordPeakResidentMemory(collapseNewest ? "assistant-history-collapsed" : "assistant-history-newest-full")

        // Offscreen rich bodies are recycled. Reach each reader through the
        // transcript's navigation owner before checking its disclosure.
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        let controller = try XCTUnwrap(coordinator.scrollPositionController)
        controller.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        let rows = ChatViewModel.transcriptMessages(from: messages)
        var heights: [CGFloat] = []
        for number in [25, 24] {
            let id = "long-body-assistant-\(number * 2 - 1)"
            let row = try XCTUnwrap(rows.first { $0.message.messageId == id })
            try await navigateTranscript(to: ChatTranscriptView.containerID(for: row.renderID), anchor: .top, using: controller)
            let heading = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Long fixture body \(number)") == true }
            let hit = try XCTUnwrap(messageMenuHit(at: heading, in: window))
            XCTAssertEqual(hit.content.messageID, id)
            heights.append(hit.rowSize.height)
            let disclosures = elements(named: "Show more", in: window).filter {
                (try? self.messageMenuHit(at: $0, in: window)?.content.messageID) == id
            }
            XCTAssertEqual(disclosures.count, number == 25 && !collapseNewest ? 0 : 1)
        }
        if collapseNewest {
            XCTAssertEqual(heights[0], heights[1], accuracy: 3, "Both replies must render their equally sized excerpts")
        } else {
            XCTAssertGreaterThan(heights[0], heights[1] * 2, "The newest reply must render its full Markdown body")
        }
    }

    private func recordPeakResidentMemory(_ scenario: String) {
        var usage = rusage()
        XCTAssertEqual(getrusage(RUSAGE_SELF, &usage), 0)
        let evidence = "TAL1114 \(scenario) peak_rss_bytes=\(usage.ru_maxrss)"
        print(evidence)
        let attachment = XCTAttachment(string: evidence)
        attachment.name = "\(scenario) peak RSS"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testTerminalExcerptTransferPreservesReaderAndBottomFollow() async throws {
        for follows in [false, true] {
            let fixture = try FixtureApp(for: self)
            let stream = ScriptedSSEStreamingClient()
            let session = SessionSummary(sessionId: "session-abc", title: "Excerpt lifecycle")
            let fixtureDraft = "Reader fixture draft"
            fixture.environment.draftStore.setDraft(fixtureDraft, for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
            let paragraphA = "Paragraph A with a link https://example.test/answer.\n\n"
            let answerA = String(repeating: paragraphA, count: 100)
            let excerptA = String(repeating: paragraphA, count: 56).trimmingCharacters(in: .whitespacesAndNewlines)
            let answerB = String(repeating: "Paragraph B is the newest full answer.\n\n", count: 100)
            let initial: [[String: Any]] = [
                ["role": "user", "content": "Question A", "message_id": "qa", "_turn_id": "A"],
                ["role": "assistant", "content": answerA, "message_id": "a", "_turn_id": "A"]
            ]
            let final = [initial[0], initial[1].merging(["_display_truncated": true, "_display_excerpt": excerptA]) { _, new in new },
                         ["role": "user", "content": "Question B", "message_id": "qb", "_turn_id": "stream-123"],
                         ["role": "assistant", "content": answerB, "message_id": "b", "_turn_id": "stream-123"]]
            var settled = false
            let viewModel = try makeScriptedChatViewModel(streamClient: stream, server: UITestFixtureEnvironment.serverURL) { request in
                let body: [String: Any]
                switch request.url?.path {
                case "/api/chat/start": body = ["session_id": "session-abc", "stream_id": "stream-123"]
                case "/api/chat/stream/status": body = ["active": false]
                case "/api/session": body = ["session": ["session_id": "session-abc", "messages": settled ? final : initial]]
                default: body = [:]
                }
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, try JSONSerialization.data(withJSONObject: body))
            }
            defer { MockURLProtocol.requestHandler = nil; stream.stop() }
            await viewModel.loadMessages()
            let window = try hostWindow(NavigationStack {
                fixture.chat(session, viewModel: viewModel, asNavigationDestination: false, loadsInitialMessages: false)
            })
            let editor = await composerTextView(in: window)
            let restoredFixtureDraft = await awaitCondition { editor?.text == fixtureDraft }
            XCTAssertTrue(restoredFixtureDraft, "The reader scenario must hydrate its fixture-owned draft, observed: \(editor?.text ?? "missing editor")")
            let scroll = try transcriptScrollView(in: window)
            let started = await viewModel.sendMessage("Question B")
            XCTAssertTrue(started)
            stream.emit(.token(answerB))
            settle(0.3)
            XCTAssertNil(viewModel.messages.first { $0.messageId == "a" }?.displayExcerpt)
            XCTAssertTrue(elements(named: "Show more", in: window).isEmpty)
            settle(0.5)
            var before: CGFloat = 0
            if !follows {
                let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
                let controller = try XCTUnwrap(coordinator.scrollPositionController)
                controller.userDidBeginDragging()
                coordinator.onFollowEvent(.userScrollBegin)
                let prompt = try XCTUnwrap(viewModel.displayedTranscriptMessages.first { $0.message.content == "Question B" })
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: prompt.renderID), anchor: .top, using: controller) {
                    XCTAssertTrue(controller.isNavigating, "The native sample must land during the requested reader navigation")
                    // A native metrics sample can arrive after the request, before its destination is laid out.
                    scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: scroll.contentOffset.y - 1), animated: false)
                    coordinator.reportMetrics(delivery: .immediate)
                }
                _ = try await requireElement(in: window, label: "Scroll to latest message")
                before = try await requireElement(in: window, label: "Question B").accessibilityFrame.minY
                XCTAssertGreaterThan(before, 0)
                XCTAssertLessThan(before, 300)
            }
            attachHostedScreenshot(window, name: follows ? "newest-reply-before-follow" : "newest-reply-before-reader")
            let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
            let detail = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: ["session_id": "session-abc", "messages": final]))
            settled = true
            stream.emit(.done(DoneStreamEvent(session: detail)))
            stream.emit(.streamEnd)
            settle(0.4)
            await viewModel.loadMessages()
            settle(0.3)
            attachHostedScreenshot(window, name: follows ? "newest-reply-after-follow" : "newest-reply-after-reader")
            if follows {
                XCTAssertLessThan(abs(scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.contentOffset.y - scroll.bounds.height), 5)
            } else {
                let after = try await requireElement(in: window, label: "Question B")
                XCTAssertEqual(after.accessibilityFrame.minY, before, accuracy: 3, "Terminal excerpt transfer moved the visible anchor")
            }
            XCTAssertEqual(viewModel.messages.first { $0.messageId == "a" }?.displayExcerpt, excerptA)
            XCTAssertNil(viewModel.messages.first { $0.messageId == "b" }?.displayExcerpt)
            window.isHidden = true
        }
    }

    func testWorkToolbarBadgesOpenTheExistingSheetsOnPhone() async throws {
        try await assertWorkToolbarBadgesOpenTheExistingSheets(size: HostedSize.phone)
    }

    func testWorkToolbarBadgesOpenTheExistingSheetsOnPad() async throws {
        try await assertWorkToolbarBadgesOpenTheExistingSheets(size: HostedSize.padLandscape)
    }

    private func assertWorkToolbarBadgesOpenTheExistingSheets(size: CGSize) async throws {
        guard #available(iOS 26, *) else { throw XCTSkip("Requires toolbar badges") }
        let fixture = try FixtureApp(["--ui-test-background-updates", "--ui-test-chat-controls"], for: self)
        let session = try await fixture.session()
        let model = ChatViewModel(session: session, server: UITestFixtureEnvironment.serverURL,
                                  client: fixture.client, liveActivityManager: SpyChatLiveActivityManager())
        await model.refreshBackgroundTasks()
        await model.dismissBackgroundTask(taskID: "bg-ui")
        XCTAssertEqual(model.pinnedBackgroundTasks.count, 1)
        XCTAssertEqual(model.pinnedBackgroundTaskCount, 1, "The fixture server's count")
        let window = try hostWindow(fixture.chat(session, viewModel: model), size: size)
        _ = try await requireElement(in: window, label: "Background tasks · 1")
        let started = await model.sendMessage("Run the deterministic fixture")
        XCTAssertTrue(started)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("/queue First queued message", in: window)
        try await sendFromComposer("/queue Second queued message", in: window)
        _ = try await requireElement(in: window, label: "2 queued")
        settle(0.3)
        attachHostedScreenshot(window, name: size == HostedSize.phone ? "work-toolbar-phone" : "work-toolbar-pad")

        let background = try XCTUnwrap(HostedAccessibility.toolbarItem("Background tasks", in: window),
                                      "Missing Background tasks toolbar item")
        let queued = try XCTUnwrap(HostedAccessibility.toolbarItem("Queued messages", in: window),
                                  "Missing Queued messages toolbar item")
        XCTAssertEqual(background.badge?.stringValue, "1")
        XCTAssertEqual(queued.badge?.stringValue, "2")
        for (item, sheetText) in [(background, "Fix CI"), (queued, "First queued message")] {
            XCTAssertTrue(UIApplication.shared.sendAction(try XCTUnwrap(item.action), to: item.target, from: item, for: nil))
            _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains(sheetText) == true }
            HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
            let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
            XCTAssertTrue(closed)
        }
        _ = await model.cancelActiveStream()
        window.isHidden = true
        window.rootViewController = nil
    }

    func testEmptyWorkHasNoToolbarEntries() async throws {
        let window = try await hostFixtureChat()
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertNil(HostedAccessibility.toolbarItem("Background tasks", in: window))
        XCTAssertNil(HostedAccessibility.toolbarItem("Queued messages", in: window))
    }

    func testOwnerQueueToolbarCountsAdmissionsAndTracksTheirRemoval() async throws {
        guard #available(iOS 26, *) else { throw XCTSkip("Requires toolbar badges") }
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerChatArgument])
        _ = try await requireElement(in: window, label: "Outcome unknown")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-queue-toolbar")
        let item = try XCTUnwrap(HostedAccessibility.toolbarItem("Queued messages", in: window),
                                 "Missing Queued messages toolbar item for owner admissions")
        XCTAssertEqual(item.badge?.stringValue, "2")
        XCTAssertTrue(UIApplication.shared.sendAction(try XCTUnwrap(item.action), to: item.target, from: item, for: nil))
        _ = try await requireElement(in: window, label: UITestFixtureURLProtocol.ownerUnknownText)
        _ = try await requireElement(in: window, label: "Then post the summary in #ops")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Discard"))
        let reduced = await awaitCondition {
            HostedAccessibility.toolbarItem("Queued messages", in: window)?.badge?.stringValue == "1"
        }
        XCTAssertTrue(reduced, "Discard must reduce the owner queue badge")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(closed)
        HostedAccessibility.activate(try await requireElement(in: window, label: "1 queued"))
        _ = try await requireElement(in: window, label: "Then post the summary in #ops")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Cancel"))
        let emptied = await awaitCondition {
            window.rootViewController?.presentedViewController == nil
                && HostedAccessibility.toolbarItem("Queued messages", in: window) == nil
        }
        XCTAssertTrue(emptied, "The last settled admission must remove the toolbar entry and close the sheet")
        XCTAssertTrue(elements(named: "1 queued", in: window).isEmpty)
    }

    /// Background work shows as one count chip above the composer (TAL-1001); its sheet lists the server's records, a
    /// delegation its subagents' progress, the full result on request, and a Dismiss that removes only finished work
    /// (TAL-372).
    func testBackgroundWorkChipOpensTheServersRecordsWithResultAndDismiss() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let containing: (String) -> (NSObject) -> Bool = { text in { $0.accessibilityLabel?.contains(text) == true } }
        // A sheet row reads its title with its kind and status; the transcript names the same work in its own rows.
        let finishedRow: (NSObject) -> Bool = { containing("Summarize the repo")($0) && containing("Background task · ")($0) }
        let chip = await awaitElement(in: window, where: containing("Background tasks · 2"))
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains(where: finishedRow), "A task row shows outside the sheet")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Worked", "The delegation row has no Worked disclosure"))
        let progress = await awaitElement(in: window, where: containing("2 of 3 done · 1 failed"))
        XCTAssertNotNil(progress, "The delegation row does not show its subagents' progress")

        HostedAccessibility.activate(try XCTUnwrap(chip, "The background tasks chip is missing"))
        let running = await awaitElement(in: window, where: containing("Fix CI"))
        XCTAssertNotNil(running, "The running delegation is missing from the sheet")
        let finished = try XCTUnwrap(
            HostedAccessibility.elements(in: window).first(where: finishedRow),
            "The finished /background task is missing from the sheet"
        )

        HostedAccessibility.activate(finished)
        _ = try await requireElement(in: window, label: "The repo has three packages.", "The full result did not load")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Dismiss"))
        let dismissed = await awaitNoElement(in: window, where: finishedRow)
        XCTAssertTrue(dismissed, "Dismiss left the finished task in the sheet")
        let remaining = await awaitElement(in: window) { containing("Fix CI")($0) && containing("Agent · ")($0) }
        XCTAssertNotNil(remaining, "Dismiss removed running work")
    }

    /// TAL-1337: an owner chat's work lists in the same sheet with only the controls its owner allows: Stop and Steer on
    /// the resident child, Stop on the process, none on a rebuilt parent's child. Stop settles from the owner's next
    /// roster; a refused Steer says so and keeps the message for another try.
    func testOwnerWorkOffersOnlyTheControlsItsOwnerAllows() async throws {
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerWorkArgument])
        let containing: (String) -> (NSObject) -> Bool = { text in { $0.accessibilityLabel?.contains(text) == true } }
        func actions(_ title: String) -> [UIAccessibilityCustomAction] {
            HostedAccessibility.elements(in: window).filter(containing(title)).flatMap { $0.accessibilityCustomActions ?? [] }
        }
        func run(_ name: String, on title: String) async throws {
            // Dialog dismissal precedes the owner's roster refresh, during which the row is still busy.
            _ = await awaitCondition { actions(title).contains { $0.name == name } }
            let action = try XCTUnwrap(actions(title).first { $0.name == name }, "\(title) offers no \(name)")
            XCTAssertTrue(action.actionHandler?(action) ?? false, "\(name) did not run")
        }
        func alert() -> UIAlertController? {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller as? UIAlertController
        }
        func steer(_ text: String) async throws {
            try await run("Steer", on: "Read the logs")
            let asked = await awaitCondition { alert()?.textFields?.isEmpty == false }
            XCTAssertTrue(asked, "Steer asked for no message")
            let field = try XCTUnwrap(alert()?.textFields?.first)
            XCTAssertEqual(field.placeholder, "Message for this agent")
            field.becomeFirstResponder()
            field.text = ""
            field.insertText(text)
            settle(0.3)
            attachHostedScreenshot(window, name: "owner-work-steer-\(text.count)")
            XCTAssertTrue(HostedAccessibility.tap("Send", in: try XCTUnwrap(alert())))
        }

        let chip = await awaitElement(in: window, where: containing("Background tasks · 3"))
        HostedAccessibility.activate(try XCTUnwrap(chip, "The owner's running work has no background tasks chip"))
        _ = await awaitElement(in: window, where: containing("Read the logs"))
        XCTAssertEqual(Set(actions("Read the logs").map(\.name)), ["Stop", "Steer"])
        XCTAssertEqual(actions("npm run dev").map(\.name), ["Stop"])
        XCTAssertEqual(actions("Check the tests").map(\.name), [], "A rebuilt parent's child is read-only")
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first { containing("Check the tests")($0) && containing("Running")($0) })
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-work-sheet")

        try await steer("Look at stderr too")
        let queued = await awaitCondition { UITestFixtureURLProtocol.ownerWorkControls.withLock { $0 } == ["steer:owner-work-resident:Look at stderr too"] }
        XCTAssertTrue(queued, "The steer did not reach the owner once")
        let closed = await awaitCondition { alert() == nil }
        XCTAssertTrue(closed, "A queued steer left a dialog up")

        try await steer("please refuse this")
        let refused = await awaitCondition { alert()?.title == "The agent didn’t take the message." }
        XCTAssertTrue(refused, "A refused steer did not say so")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-work-steer-refused")
        XCTAssertTrue(HostedAccessibility.tap("OK", in: try XCTUnwrap(alert())))
        _ = await awaitCondition { alert() == nil }
        try await run("Steer", on: "Read the logs")
        let kept = await awaitCondition { alert()?.textFields?.first?.text == "please refuse this" }
        XCTAssertTrue(kept, "The refused message was not kept")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        _ = await awaitCondition { alert() == nil }

        try await run("Stop", on: "npm run dev")
        let stopped = await awaitNoElement(in: window, where: containing("npm run dev"))
        XCTAssertTrue(stopped, "The owner's roster after Stop still pins the process")
        XCTAssertEqual(UITestFixtureURLProtocol.ownerWorkControls.withLock { $0 }.filter { $0.hasPrefix("stop:") }, ["stop:owner-work-server"])
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: containing("Read the logs")), "Stop reached other work")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-work-after-stop")
    }

    /// TAL-1337: an owner lost while its work is open keeps the sheet, which says why its rows went; closed, the same
    /// reason stands above the composer, since no rows remain to open.
    func testOwnerWorkThatCannotBeReadStillSaysWhy() async throws {
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerWorkArgument])
        let containing: (String) -> (NSObject) -> Bool = { text in { $0.accessibilityLabel?.contains(text) == true } }
        let chip = await awaitElement(in: window, where: containing("Background tasks · 3"))
        HostedAccessibility.activate(try XCTUnwrap(chip, "The owner's running work has no background tasks chip"))
        let row = await awaitElement(in: window, where: containing("npm run dev"))
        let stop = try XCTUnwrap(row?.accessibilityCustomActions?.first { $0.name == "Stop" }, "npm run dev offers no Stop")

        // The owner goes away: the reread after Stop lists none of its work.
        UITestFixtureURLProtocol.ownerWorkUnavailable.withLock { $0 = true }
        XCTAssertTrue(stop.actionHandler?(stop) ?? false)
        let emptied = await awaitNoElement(in: window, where: containing("Read the logs"))
        XCTAssertTrue(emptied, "The unreadable owner's rows stayed")
        _ = try await requireElement(in: window, label: "The agent can’t report status right now.")
        XCTAssertNotNil(window.rootViewController?.presentedViewController, "The sheet closed without saying why")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-work-unavailable-sheet")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(closed)
        let notice = await awaitElement(in: window) { ($0 as? UIView)?.accessibilityIdentifier == "background-work-owner-notice-chip" || ($0.accessibilityLabel == "The agent can’t report status right now.") }
        XCTAssertNotNil(notice, "Nothing above the composer says the owner's work cannot be read")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-work-unavailable-chip")
    }

    /// TAL-1580: once the delegation's row has finished, the server's summary of what still runs and what awaits delivery
    /// keeps Background Work open from the composer, and the sheet shows it above the finished work.
    func testTheServersDelegationSummaryStaysReachableAfterTheRowsFinishOnPhone() async throws {
        try await assertTheServersDelegationSummaryStaysReachableAfterTheRowsFinish(name: "phone", size: HostedSize.phone)
    }

    func testTheServersDelegationSummaryStaysReachableAfterTheRowsFinishOnDuoInner() async throws {
        try await assertTheServersDelegationSummaryStaysReachableAfterTheRowsFinish(name: "duo-inner", size: HostedSize.duoInner)
    }

    private func assertTheServersDelegationSummaryStaysReachableAfterTheRowsFinish(name: String, size: CGSize) async throws {
        let fixture = try FixtureApp(["--ui-test-background-updates"], for: self)
        let summary = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("delegation-status")) as? [String: Any])
        let status = try JSONSerialization.data(withJSONObject: try XCTUnwrap(summary["running_and_awaiting"]))
        UITestFixtureURLProtocol.backgroundDelegationStatus.withLock { $0 = status }
        let session = try await fixture.session(UITestFixtureURLProtocol.sessionID)
        let model = ChatViewModel(session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
                                  liveActivityManager: SpyChatLiveActivityManager(), networkPath: nil)
        let window = try hostWindow(fixture.chat(session, viewModel: model), size: size)

        let chip = try await requireElement(in: window, label: "1 running · 3 awaiting delivery", "Nothing pinned, and the summary has no way in")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Background tasks · 0"))
        settle(0.3)
        attachHostedScreenshot(window, name: "delegation-summary-chip-\(name)")
        HostedAccessibility.activate(chip)
        _ = try await requireElement(in: window, label: "1 running, 3 awaiting delivery", "The sheet does not read the summary")
        settle(0.5)
        XCTAssertNotNil(window.rootViewController?.presentedViewController, "The sheet closed although the server shows the summary")
        attachHostedScreenshot(window, name: "delegation-summary-sheet-\(name)")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(closed)
        // The pre-fix server showed an empty summary. Clients still obey that explicit visibility field.
        var oldServer = try XCTUnwrap(summary["available_zero"] as? [String: Any])
        oldServer["visible"] = true
        let empty = try JSONSerialization.data(withJSONObject: oldServer)
        UITestFixtureURLProtocol.backgroundDelegationStatus.withLock { $0 = empty }
        await model.refreshBackgroundTasks()
        _ = try await requireElement(in: window, label: "Nothing running or awaiting delivery")
        settle(0.3)
        attachHostedScreenshot(window, name: "delegation-delivered-before-\(name)")
        let delivered = try JSONSerialization.data(withJSONObject: try XCTUnwrap(summary["available_zero"]))
        UITestFixtureURLProtocol.backgroundDelegationStatus.withLock { $0 = delivered }
        await model.refreshBackgroundTasks()
        let hidden = await awaitCondition { HostedAccessibility.element(in: window, label: "Nothing running or awaiting delivery") == nil }
        XCTAssertTrue(hidden)
        settle(0.3)
        XCTAssertNil(HostedAccessibility.toolbarItem("Background tasks", in: window), "The toolbar still exposes delivered work")
        attachHostedScreenshot(window, name: "delegation-delivered-\(name)")
        model.cleanupPollingTasks()
        window.isHidden = true
        window.rootViewController = nil
    }

    func testDeliverySummaryWordsEachSharedFixture() throws {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("delegation-status")) as? [String: Any])
        func words(_ key: String) throws -> [String] {
            let data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(fixture[key]))
            return BackgroundWorkSheet.deliverySummary(try APIClient.responseDecoder().decode(DelegationStatus.self, from: data))
        }
        XCTAssertEqual(try words("running"), ["2 running"])
        XCTAssertEqual(try words("awaiting_delivery"), ["1 awaiting delivery"], "A completion awaiting delivery is neither failed nor delivered")
        XCTAssertEqual(try words("running_and_awaiting"), ["1 running", "3 awaiting delivery"])
        XCTAssertEqual(try words("available_zero"), ["Nothing running or awaiting delivery"])
        XCTAssertEqual(try words("unknown"), ["Delivery status unavailable"], "Counts the server could not read are not zero")
        XCTAssertEqual(try words("unsupported"), ["This chat’s owner doesn’t report delivery status"])
        let dispatching = DelegationStatus(availability: .available, runningCount: 0, awaitingDeliveryCount: 0, memoryLive: true, visible: true, refresh: true)
        XCTAssertEqual(BackgroundWorkSheet.deliverySummary(dispatching), ["Running"])
        let future = DelegationStatus(availability: .unrecognized("paused"), runningCount: 4, awaitingDeliveryCount: 0, memoryLive: nil, visible: true, refresh: false)
        XCTAssertEqual(BackgroundWorkSheet.deliverySummary(future), ["Delivery status unavailable"])
    }

    /// TAL-2263: each child session a delegation's record lists opens its own transcript from the sheet through the
    /// session deep link, named by its goal when the delegation ran several, and before any result exists. A record
    /// from an older server, or one whose list is not a list, shows its row alone.
    func testADelegationsChildSessionsOpenTheirTranscripts() async throws {
        let tasks = try APIClient.responseDecoder().decode([BackgroundWorkTask].self, from: Data("""
        [
          {"task_id": "one", "kind": "delegation", "status": "running", "title": "Check the tests", "result_available": false, "pinned": true,
           "child_sessions": [{"goal": "Check the tests", "session_id": "child-solo"}]},
          {"task_id": "many", "kind": "delegation", "status": "completed", "title": "Audit the release", "result_available": true, "pinned": true,
           "child_sessions": [{"goal": "Read the logs", "session_id": "child-logs"}, {"goal": "No session"}, "junk", {"goal": "Trace the crash", "session_id": "child-crash"}]},
          {"task_id": "old", "kind": "delegation", "status": "running", "title": "From an older server", "pinned": true},
          {"task_id": "bad", "kind": "delegation", "status": "running", "title": "Not a list", "pinned": true, "child_sessions": "nope"}
        ]
        """.utf8))
        let opened = LockedTestValue([URL]())
        let window = try hostWindow(
            BackgroundWorkSheet(tasks: tasks, loadResult: { _ in nil }, dismiss: { _ in })
                .environment(\.openURL, OpenURLAction { opened.value.append($0); return .handled })
        )
        let prefix = "background-task-transcript-"
        func transcripts() -> [NSObject] {
            HostedAccessibility.elements(in: window).filter { HostedAccessibility.identifier(of: $0)?.hasPrefix(prefix) == true }
        }
        let listed = await awaitCondition { transcripts().count == 3 }
        XCTAssertTrue(listed, "The sheet lists \(transcripts().count) transcripts for three child sessions")
        XCTAssertEqual(transcripts().map(\.accessibilityLabel), ["Transcript", "Read the logs", "Trace the crash"])
        for element in transcripts() {
            XCTAssertTrue(HostedAccessibility.activate(element))
            let sessionID = try XCTUnwrap(HostedAccessibility.identifier(of: element)).dropFirst(prefix.count)
            XCTAssertEqual(opened.value.last.flatMap(TalariaDeepLink.sessionID(from:)), String(sessionID))
        }
        XCTAssertEqual(opened.value.count, 3)
        for taskID in ["one", "many", "old", "bad"] {
            XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "background-task-row-\(taskID)"), "\(taskID) lost its row")
        }
        attachHostedScreenshot(window, name: "background-tasks-transcripts")
    }

    /// TAL-1043: an owner chat lists the owner's inputs with only the server's actions. An input with an unknown
    /// outcome blocks sending until Retry returns its text to the composer; nothing resends on its own.
    func testOwnerChatRecoversAnUnknownInputOnPhone() async throws {
        try await assertOwnerChatRecovery(size: HostedSize.phone, name: "phone")
    }

    func testOwnerChatRecoversAnUnknownInputOnPad() async throws {
        try await assertOwnerChatRecovery(size: HostedSize.padLandscape, name: "pad")
    }

    private func assertOwnerChatRecovery(size: CGSize, name: String) async throws {
        continueAfterFailure = false
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerChatArgument], size: size)
        let chip = try await requireElement(in: window, label: "Outcome unknown")
        _ = try await requireElement(in: window, label: "Retry or discard the unknown input first.")
        let options = HostedAccessibility.element(in: window, label: "Composer options")
        XCTAssertTrue(options.map { $0.accessibilityTraits.contains(.notEnabled) } ?? true, "An owner chat still takes no files")
        let modelPicker = try await requireElement(in: window, label: "Select model")
        let workspacePicker = try await requireElement(in: window, label: "Choose workspace path")
        XCTAssertFalse(modelPicker.accessibilityTraits.contains(.notEnabled), "An attached owner accepts model changes")
        XCTAssertFalse(workspacePicker.accessibilityTraits.contains(.notEnabled), "An attached owner accepts workspace changes")
        XCTAssertTrue(HostedAccessibility.activate(modelPicker))
        let reasoning = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "composer-model-effort" }
        XCTAssertTrue(reasoning.accessibilityTraits.contains(.notEnabled), "Reasoning remains with its owner")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-unknown-\(name)")
        HostedAccessibility.activate(workspacePicker)
        _ = try await requireElement(in: window, label: "Choose Workspace")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-workspace-picker-\(name)")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let pickerClosed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(pickerClosed)

        HostedAccessibility.activate(chip)
        _ = try await requireElement(in: window, label: UITestFixtureURLProtocol.ownerUnknownText)
        _ = try await requireElement(in: window, label: "Then post the summary in #ops")
        XCTAssertEqual(elements(named: "Retry", in: window).count, 1, "Only the unknown input offers Retry")
        XCTAssertEqual(elements(named: "Discard", in: window).count, 1)
        XCTAssertEqual(elements(named: "Cancel", in: window).count, 1, "Only the queued input offers Cancel")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-inputs-\(name)")

        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Retry", in: window).first))
        let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(closed, "Retry leaves the sheet for the composer")
        _ = try await requireElement(in: window, label: "1 queued")
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, UITestFixtureURLProtocol.ownerUnknownText, "Retry returns the text to review, unsent")
        let unknownGone = await awaitNoElement(in: window) { $0.accessibilityLabel == "Retry or discard the unknown input first." }
        XCTAssertTrue(unknownGone)
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-retried-\(name)")
    }

    /// TAL-1043: an owner the App cannot write to keeps the chat read-only with the server's reason.
    func testAReadOnlyOwnerChatSaysWhy() async throws {
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerChatServedArgument])
        _ = try await requireElement(in: window, label: "This gateway's chats are read-only here.")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-served-phone")
    }

    /// TAL-1043: an owner's approval offers only the choices its owner accepts, and no approval bypass.
    func testOwnerApprovalOffersOnlyTheOwnersChoices() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-full", UITestFixtureURLProtocol.ownerApprovalArgument])
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Approval required")
        _ = try await requireElement(in: window, label: "Allow once")
        _ = try await requireElement(in: window, label: "Deny")
        for hidden in ["Allow session", "Always allow", "Skip all this session"] {
            XCTAssertNil(HostedAccessibility.element(in: window, label: hidden), "\(hidden) is not the owner's choice")
        }
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-approval-phone")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Allow once"))
        _ = try await requireElement(in: window, label: "Clarification Required")
    }

    func testReopenedChatShowsWithdrawalUntilTheNextSend() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-full", "--ui-test-prompt-withdrawn"])
        let label = "Approval timed out, so the action did not run."
        _ = try await requireElement(in: window, label: label)
        attachHostedScreenshot(window, name: "approval-withdrawal-reopened")
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Allow once")
        XCTAssertNil(HostedAccessibility.element(in: window, label: label))
        attachHostedScreenshot(window, name: "approval-withdrawal-next-send")
    }

    private static let approvalChoices = ["Allow once", "Allow session", "Always allow", "Deny", "Skip all this session"]

    /// The full fixture chat with its approval pending and the keyboard down, as a user reading it leaves it.
    private func awaitFixtureApproval(in window: UIWindow) async throws {
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Allow once")
        await composerTextView(in: window)?.resignFirstResponder()
    }

    /// TAL-2021: an approval waits in the composer's question slot, so nothing dims or covers the transcript.
    func testAPendingApprovalLeavesTheTranscriptUncoveredAndScrollable() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-full"])
        try await awaitFixtureApproval(in: window)
        settle(0.3)
        attachHostedScreenshot(window, name: "approval-slot-phone")
        let transcript = try transcriptScrollView(in: window)
        XCTAssertTrue(transcript.isScrollEnabled)
        let visible = transcript.convert(transcript.bounds, to: window)
        let point = CGPoint(x: visible.midX, y: visible.minY + 120)
        let hit = try XCTUnwrap(window.hitTest(point, with: nil))
        XCTAssertTrue(hit.isDescendant(of: transcript), "A view covers the transcript while an approval waits: \(hit)")
    }

    /// TAL-2021: the chevron folds the approval into a chip above the composer; the chip brings it back.
    func testCollapsingTheApprovalLeavesAChipThatRestoresIt() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-full"])
        try await awaitFixtureApproval(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Collapse approval"))
        let chip = try await requireElement(in: window, label: "Approval needed")
        let hidden = await awaitCondition { HostedAccessibility.element(in: window, label: "Allow once") == nil }
        XCTAssertTrue(hidden, "Collapsing must hide the approval's choices")
        settle(0.3)
        attachHostedScreenshot(window, name: "approval-slot-collapsed")
        HostedAccessibility.activate(chip)
        _ = try await requireElement(in: window, label: "Allow once")
        let chipGone = await awaitCondition { HostedAccessibility.element(in: window, label: "Approval needed") == nil }
        XCTAssertTrue(chipGone, "The chip must leave once the approval is expanded again")
    }

    /// TAL-2021: at the largest accessibility text size the approval's last choice scrolls into view.
    func testTheLastApprovalChoiceScrollsIntoViewAtTheLargestTextSize() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-full"]) {
            $0.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        }
        try await awaitFixtureApproval(in: window)
        _ = try await requireElement(in: window, label: "Skip all this session")
        let transcript = try transcriptScrollView(in: window)
        var lastFrame = CGRect.null
        var viewport = CGRect.null
        let revealed = await awaitCondition {
            // Each poll finds the card's scroll view afresh and scrolls it to its current end: on a slow host the
            // card's content is still sizing when the choice first appears, so a lookup made once finds nothing.
            guard let last = HostedAccessibility.element(in: window, label: "Skip all this session"),
                  let description = HostedAccessibility.element(in: window, label: "Allow the deterministic fixture to continue.")
            else { return false }
            lastFrame = window.convert(last.accessibilityFrame, from: nil)
            let top = window.convert(description.accessibilityFrame, from: nil)
            // The card's scroll view holds the description in its content, even once scrolled past it.
            guard let scroll = window.firstView(ofType: UIScrollView.self, where: {
                $0 !== transcript && $0.contentSize.height > $0.bounds.height
                    && CGRect(origin: .zero, size: $0.contentSize).contains($0.convert(CGPoint(x: top.midX, y: top.minY + 1), from: window))
            }) else { return false }
            let bottom = max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
            scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
            viewport = scroll.convert(scroll.bounds, to: window)
            lastFrame = window.convert(last.accessibilityFrame, from: nil)
            // Scrolling is vertical: the choice must lie within the card's visible height, and on screen.
            return lastFrame.height > 0 && lastFrame.minY >= viewport.minY && lastFrame.maxY <= viewport.maxY
                && window.bounds.contains(lastFrame)
        }
        settle(0.3)
        attachHostedScreenshot(window, name: "approval-slot-ax5")
        XCTAssertTrue(revealed, "Skip all this session stays out of view: \(lastFrame) in the card's scroll view \(viewport)")
    }

    /// TAL-474 through TAL-2021: the approval moves with the composer to the trailing pane of a book fold.
    func testBookFoldMovesTheApprovalAndItsChoices() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-full"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(FoldHost(content: AnyView(fixture.chat(session))),
                                    size: CGSize(width: 900, height: 700))
        try await awaitFixtureApproval(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let allow = try await requireElement(in: window, label: "Allow once")
        let displaced = await awaitCondition { window.convert(allow.accessibilityFrame, from: nil).minX >= 470 }
        XCTAssertTrue(displaced, "The approval still crosses the book fold")
        for title in Self.approvalChoices {
            let button = try await requireElement(in: window, label: title)
            XCTAssertGreaterThanOrEqual(window.convert(button.accessibilityFrame, from: nil).minX, 470, "\(title) crosses the fold")
        }
        XCTAssertGreaterThan(try transcriptScrollView(in: window).bounds.width, 800)
        settle(0.3)
        attachHostedScreenshot(window, name: "approval-slot-book")
    }

    /// TAL-474 through TAL-2021: in tabletop the approval sits with the composer below the fold, never across it.
    func testTabletopKeepsTheApprovalBelowTheFold() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-full"], for: self)
        let session = try await fixture.session()
        let recorder = ChatBodyEvaluationRecorder()
        let fold = CGRect(x: -100, y: 330, width: 2000, height: 40)
        let chat = fixture.chat(session, asNavigationDestination: false)
            .ignoresSafeArea(.container)
            .environment(\.chatBodyEvaluation, recorder)
        let window = try hostWindow(FoldHost(content: AnyView(chat), division: fold), size: CGSize(width: 900, height: 900))
        try await awaitFixtureApproval(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let foldInWindow = fold.offsetBy(dx: 0, dy: recorder.transcriptFrame.minY)
        let allow = try await requireElement(in: window, label: "Allow once")
        let moved = await awaitCondition { window.convert(allow.accessibilityFrame, from: nil).minY >= foldInWindow.maxY }
        XCTAssertTrue(moved, "The approval must sit below the tabletop fold: \(window.convert(allow.accessibilityFrame, from: nil)) fold \(foldInWindow)")
        for title in Self.approvalChoices {
            let button = try await requireElement(in: window, label: title)
            XCTAssertFalse(window.convert(button.accessibilityFrame, from: nil).intersects(foldInWindow), "\(title) crosses the fold")
        }
        settle(0.3)
        attachHostedScreenshot(window, name: "approval-slot-tabletop")
    }

    /// The session's standing `/goal` shows as one chip above the composer, worded from the server's field (TAL-833).
    func testTheStandingGoalShowsAboveTheComposer() async throws {
        let window = try await hostFixtureChat(["--ui-test-goal"])
        let chip = await awaitElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Goal parked · 5/20 turns · until ") == true
                && $0.accessibilityLabel?.hasSuffix(" · CI running · Ship the release notes") == true
        }
        XCTAssertNotNil(chip, "The parked goal chip is missing")
    }

    /// Steers pending from another device offer only the actions the server allows; Send now explains a live
    /// requeue, and Edit appends the steer after the draft (TAL-300, TAL-1000).
    func testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers"])
        try await sendFromComposer("Back up the cluster", in: window)

        _ = try await requireElement(in: window, label: "Check the backup logs too", "The pending steer from Web is missing")
        _ = try await requireElement(in: window, label: "Skip the cache", "The second pending steer is missing")
        let waiting = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Waiting for agent") == true }
        XCTAssertNotNil(waiting)
        // Only the actions the server allows: the second steer offers no Send now.
        XCTAssertEqual(elements(named: "Send now", in: window).count, 1)
        XCTAssertEqual(elements(named: "Edit steering message", in: window).count, 2)
        XCTAssertEqual(elements(named: "Cancel steering message", in: window).count, 2)

        // TAL-1001: Send now explains itself in one short chip, however often it is tapped, that goes on its own.
        let isNotice: (NSObject) -> Bool = { $0.accessibilityLabel == "The agent takes it at its next step." }
        for _ in 0..<5 {
            HostedAccessibility.activate(try XCTUnwrap(elements(named: "Send now", in: window).first))
            _ = await awaitElement(in: window, where: isNotice)
        }
        let notice = await awaitElement(in: window, where: isNotice)
        XCTAssertNotNil(notice, "Send now did not explain the live requeue")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter(isNotice).count, 1, "Repeated Send now stacked notices")
        XCTAssertEqual(notice?.accessibilityValue, "Information", "The notice does not say its kind")
        attachHostedScreenshot(window, name: "send-now-phone")
        let dismissed = await awaitNoElement(in: window, timeout: 5, where: isNotice)
        XCTAssertTrue(dismissed, "The notice never went away on its own")

        // Edit appends the steer after the draft, a blank line between.
        try await typeIntoComposer("Draft", in: window)
        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Edit steering message", in: window).first))
        let edited = await awaitNoElement(in: window) { $0.accessibilityLabel == "Check the backup logs too" }
        XCTAssertTrue(edited, "The edited steer is still pending")
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, "Draft\n\nCheck the backup logs too")
    }

    /// Active approval bypass shows as a 44-point chip that asks before turning bypass off; Cancel keeps it, and it
    /// leaves once the server confirms (TAL-664).
    func testApprovalBypassChipTurnsBypassOffForTheSession() async throws {
        let window = try await hostFixtureChat(["--ui-test-approval-bypass"])
        let isChip: (NSObject) -> Bool = { $0.accessibilityLabel == "Approval bypass active" }
        let chip = try await requireElement(in: window, "The fixture never showed active bypass", where: isChip)
        XCTAssertTrue(chip.accessibilityTraits.contains(.button), "The bypass status is not an actionable button")
        XCTAssertGreaterThanOrEqual(chip.accessibilityFrame.height, 44)
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The chip is off screen")

        HostedAccessibility.activate(chip)
        let asked = await presentedAlert(in: window)
        let cancelled = try XCTUnwrap(asked, "Tapping the chip did not ask before changing bypass")
        XCTAssertEqual(cancelled.title, "Turn off approval bypass")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: cancelled))
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed, "Cancel left the confirmation up")
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isChip), "Cancel turned bypass off")

        HostedAccessibility.activate(try await requireElement(in: window, where: isChip))
        let confirmed = await presentedAlert(in: window)
        XCTAssertTrue(HostedAccessibility.tap("Turn off approval bypass", in: try XCTUnwrap(confirmed)))
        let removed = await awaitNoElement(in: window, where: isChip)
        XCTAssertTrue(removed, "A server-confirmed disabled bypass left the chip")
    }

    /// The Agent's notices show as chips above the composer with the server's text, and Dismiss hides one (TAL-831).
    func testTheAgentsNoticesShowAboveTheComposerAndDismiss() async throws {
        let window = try await hostFixtureChat(["--ui-test-session-notices"])
        let warning = UITestFixtureEnvironment.sessionNoticeWarning
        let chip = try await requireElement(in: window, label: warning, "The Agent's warning is not above the composer")
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The warning is off screen")
        _ = try await requireElement(in: window, label: "You've used 90% of your credits.", "The Agent's credit notice is missing")

        let dismissals = elements(named: "Dismiss notice", in: window)
        XCTAssertEqual(dismissals.count, 2, "Each notice needs its own Dismiss")
        HostedAccessibility.activate(try XCTUnwrap(dismissals.first))
        let dismissed = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(dismissed, "Dismiss left the warning up")
        let kept = await awaitElement(in: window, label: "You've used 90% of your credits.")
        XCTAssertNotNil(kept, "Dismiss hid the other notice")
    }

    /// A session notice longer than two lines opens to its full text on a tap and closes on a second one; Dismiss still
    /// works while it is open (TAL-1016).
    func testTappingALongSessionNoticeShowsItsFullText() async throws {
        let window = try await hostFixtureChat(["--ui-test-session-notices"])
        let warning = UITestFixtureEnvironment.sessionNoticeWarning
        func chip() -> NSObject? { HostedAccessibility.elements(in: window).first { $0.accessibilityLabel == warning } }
        func height() -> CGFloat { chip()?.accessibilityFrame.height ?? 0 }
        _ = try await requireElement(in: window, label: warning, "The long notice is not above the composer")
        let collapsed = height()
        attachHostedScreenshot(window, name: "Long session notice, collapsed")

        HostedAccessibility.activate(try XCTUnwrap(chip()))
        let opened = await awaitCondition { height() > collapsed + 10 }
        attachHostedScreenshot(window, name: "Long session notice, expanded")
        XCTAssertTrue(opened, "Tapping the notice left it at \(height()) pt, its two-line \(collapsed) pt")
        XCTAssertTrue(chip()?.accessibilityTraits.contains(.button) == true, "The notice text is not a button")
        XCTAssertEqual(chip()?.accessibilityHint, "Show less")

        HostedAccessibility.activate(try XCTUnwrap(chip()))
        let closed = await awaitCondition { abs(height() - collapsed) < 1 }
        XCTAssertTrue(closed, "A second tap left the notice at \(height()) pt, not its two-line \(collapsed) pt")
        XCTAssertEqual(chip()?.accessibilityHint, "Show full notice")

        HostedAccessibility.activate(try XCTUnwrap(chip()))
        let reopened = await awaitCondition { height() > collapsed + 10 }
        XCTAssertTrue(reopened, "A third tap did not open the notice before Dismiss")
        let dismiss = elements(named: "Dismiss notice", in: window).first { $0.accessibilityValue == warning }
        HostedAccessibility.activate(try XCTUnwrap(dismiss, "The open notice has no Dismiss"))
        let dismissed = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(dismissed, "Dismiss left the open notice up")
    }

    /// The Agent's notices arrive on the stream, and the one the Agent clears leaves its chip (TAL-831).
    func testANoticeTheServerClearsLeavesItsChip() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers", "--ui-test-session-notices"])
        try await sendFromComposer("Back up the cluster", in: window)
        let warning = UITestFixtureEnvironment.sessionNoticeWarning
        _ = try await requireElement(in: window, label: warning, "The stream's warning is not above the composer")
        // The fixture's Agent clears its warning after the steer's edit.
        HostedAccessibility.activate(try await requireElement(in: window, label: "Edit steering message"))
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(cleared, "The warning the server cleared is still up")
        let kept = await awaitElement(in: window, label: "You've used 90% of your credits.")
        XCTAssertNotNil(kept, "The clear hid the notice the server kept")
    }

    /// A manual /compress shows in the run status chip, timed from the server's job start, leaves the composer's
    /// placeholder alone, and clears its draft as it starts (TAL-1006).
    func testManualCompressionShowsInTheRunStatusChip() async throws {
        let window = try await hostFixtureChat()
        try await sendFromComposer("/compress", in: window)
        // The chip shows as the command is sent; its elapsed time follows once the server's job start arrives.
        let chip = try await requireElement(in: window, "The chip never showed the time since the server's job start") {
            $0.accessibilityLabel?.hasSuffix("is compressing the context") == true
                && $0.accessibilityValue?.hasPrefix("running for 1 minute") == true
        }
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The chip is off screen")
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains("Compressing context..."), "The composer placeholder still says it")
        // A typed command leaves the composer when it is sent, not when it finishes (the job above is still running).
        _ = await awaitCondition { self.composerDraftText(in: window) == "" }
        XCTAssertEqual(composerDraftText(in: window), "", "The /compress draft stayed in the composer while the command ran")
    }

    /// An edit or regenerate the server holds asks with the server's count, the edit only once its sheet has closed;
    /// Cancel keeps the transcript (TAL-929).
    func testHeldEditAndRegenerateAskWithTheServersCount() async throws {
        let window = try await hostFixtureChat(["--ui-test-compaction-row"])
        func alert() -> UIAlertController? {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller as? UIAlertController
        }
        func choose(_ title: String, on label: String) async throws {
            let row = try await requireElement(in: window, label: label)
            let hit = try XCTUnwrap(try messageMenuHit(at: row, in: window), "\(label) has no message menu")
            try XCTUnwrap(hit.content.actions.first { $0.title == title }, "\(label) offers no \(title)").handler()
        }

        try await choose("Edit Message", on: "Plan the migration.")
        let presented = await presentedController(in: window)
        let sheet = try XCTUnwrap(presented, "Edit opened no sheet")
        try await activateSend(in: sheet.view)
        let editAsked = await awaitCondition { alert() != nil }
        XCTAssertTrue(editAsked, "The held edit never asked")
        XCTAssertEqual(alert()?.title, "Discard Later Messages?")
        XCTAssertEqual(alert()?.message, "Editing this message will discard 5 later messages.")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        let editCancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(editCancelled, "Cancel left the confirmation up")

        try await choose("Regenerate Response", on: "Here is the plan.")
        let regenerateAsked = await awaitCondition { alert() != nil }
        XCTAssertTrue(regenerateAsked, "The held regenerate never asked")
        XCTAssertEqual(alert()?.message, "Regenerating this response will discard 5 later messages.")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        let regenerateCancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(regenerateCancelled, "Cancel left the confirmation up")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Step one done."), "Cancel changed the transcript")
    }

    /// TAL-2058: the ask the safety filter refused, from the shared contract's `content_refused_session`, shows once,
    /// greyed under the server's notice, with no message actions and no reply; the prompt before it keeps its own.
    func testARefusedAskShowsOnceUnderTheServersNoticeWithoutActions() async throws {
        let fixture = try FixtureApp(for: self)
        let sessions = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("web-session")) as? [String: Any])
        let rows = try XCTUnwrap((sessions["content_refused_session"] as? [String: Any])?["messages"] as? [[String: Any]])
        let refused = try XCTUnwrap(rows.first { $0["_marker_kind"] as? String == "content_refused" })
        let (askText, noticeText) = (try XCTUnwrap(refused["content"] as? String), try XCTUnwrap(refused["_refused_notice"] as? String))
        let promptText = try XCTUnwrap(rows.first { $0["role"] as? String == "user" && $0["_marker_kind"] == nil }?["content"] as? String)
        let replyText = try XCTUnwrap(rows.first { $0["role"] as? String == "assistant" }?["content"] as? String)
        var detail = UITestFixtureURLProtocol.session(id: UITestFixtureURLProtocol.sessionID, title: "Refused")
        detail["messages"] = rows
        let body = try JSONSerialization.data(withJSONObject: ["session": detail])
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = body }
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)
        defer { window.isHidden = true }

        let ask = try await requireElement(in: window, label: askText)
        let hit = try messageMenuHit(at: ask, in: window)
        XCTAssertNil(hit, "The refused ask offers message actions: \(hit?.content.actions.map(\.title) ?? [])")
        let notice = await awaitElement(in: window, label: noticeText)
        XCTAssertNotNil(notice, "The server's notice is not shown")
        if let notice { XCTAssertLessThan(notice.accessibilityFrame.maxY, ask.accessibilityFrame.minY + 1, "The notice is not above the ask") }
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == askText }.count, 1, "The ask is not shown once")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Retry"), "The refused ask offers Retry")
        let reply = try await requireElement(in: window, label: replyText)
        XCTAssertLessThan(reply.accessibilityFrame.maxY, ask.accessibilityFrame.minY, "A reply sits under the refused ask")
        let prompt = try await requireElement(in: window, label: promptText)
        let promptActions = try XCTUnwrap(try messageMenuHit(at: prompt, in: window), "The earlier prompt lost its menu").content.actions
        XCTAssertTrue(promptActions.contains { $0.title == "Edit Message" }, "The earlier prompt lost Edit")
        settle(0.3)
        attachHostedScreenshot(window, name: "content-refused-phone")
    }

    /// What the transcript's long press resolves to at `element`'s centre (TAL-485): the press handler's own registry
    /// and policy, read from the hosted transcript. The touch arbitration itself is the phone check's.
    private func messageMenuTarget(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuTarget? {
        guard let hit = try messageMenuHit(at: element, in: window) else { return nil }
        return ChatMessageMenuPolicy.target(
            at: hit.localPoint, linkRegions: hit.content.linkRegions, controlRegions: hit.content.controlRegions
        )
    }

    /// The message row a long press at `element`'s centre lands on, from the press handler's own registry.
    private func messageMenuHit(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuRegistry.Hit? {
        let frame = window.convert(element.accessibilityFrame, from: nil)
        return try messageMenuHit(at: CGPoint(x: frame.midX, y: frame.midY), in: window)
    }

    private func messageMenuHit(at point: CGPoint, in window: UIWindow) throws -> ChatMessageMenuRegistry.Hit? {
        let registry = try messageMenuRegistry(in: window)
        let scrollView = try transcriptScrollView(in: window)
        return registry.hit(at: scrollView.convert(point, from: window), in: scrollView)
    }

    private func messageMenuRegistry(in window: UIWindow) throws -> ChatMessageMenuRegistry {
        let host = try XCTUnwrap(window.firstView(ofType: ChatMessageMenuHostView.self), "The transcript has no long-press handler")
        let stored = Dictionary(uniqueKeysWithValues: Mirror(reflecting: host).children.compactMap { child in
            child.label.map { ($0, child.value) }
        })
        return try XCTUnwrap(stored["registry"] as? ChatMessageMenuRegistry)
    }

    private func hasHeldHistoryPage(before offset: Int) -> Bool {
        UITestFixtureHold.shared.pendingRequests.contains { request in
            guard let url = request.url, url.path == "/api/session" else { return false }
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains {
                $0.name == "msg_before" && $0.value == String(offset)
            } == true
        }
    }

    /// TAL-2317: a Talaria tool's row draws the Talaria mark as a template image and reads by the tool's name, in light
    /// and dark appearance and at an accessibility text size.
    func testTalariaToolRowShowsTheTalariaMarkAndTheToolName() throws {
        XCTAssertEqual(UIImage(named: AssistantActivitySummary.talariaMarkIcon)?.renderingMode, .alwaysTemplate)
        let calls = [
            ToolCall(id: "talaria-done", name: "profile_list", preview: nil, args: nil, kind: .talaria, target: "profile_list", isCompleted: true),
            ToolCall(id: "talaria-running", name: "session_list", preview: nil, args: nil, kind: .talaria, target: "session_list", isCompleted: false)
        ]
        for (name, type, style) in [("light", DynamicTypeSize.large, UIUserInterfaceStyle.light), ("dark", .large, .dark), ("accessibility-dark", .accessibility3, .dark)] {
            let window = try hostWindow(VStack { ForEach(calls) { ToolCallCardView(toolCall: $0) } }.padding().dynamicTypeSize(type)) { $0.userInterfaceStyle = style }
            for label in ["Used profile_list", "Using session_list"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: label).isEmpty, "\(name): \(label)")
            }
            attachHostedScreenshot(window, name: "talaria-tool-row-\(name)")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    /// TAL-2335: a finished row reads its outcome after its label, past a middle dot: routine outcomes in the secondary tier,
    /// a failure in red and a wait on the user in orange, in light and dark; a running row shows none.
    func testToolRowsShowTheServerOutcomeAfterTheLabel() throws {
        func call(_ id: String, _ name: String, _ kind: ToolDisplayKind, _ target: String, _ outcome: ToolOutcome?, done: Bool = true) -> ToolCall {
            ToolCall(id: id, name: name, preview: nil, args: nil, kind: kind, target: target, resultView: ToolResultView(text: "ok", outcome: outcome), isCompleted: done)
        }
        let calls = [
            call("send", "session_send", .talaria, "session_send", ToolOutcome(key: .sent, tone: .neutral)),
            call("memory", "memory", .memory, "", ToolOutcome(key: .memoryAdded, tone: .neutral, count: 1)),
            call("make", "terminal", .shell, "npm test -- auth.spec.ts", ToolOutcome(key: .exit, tone: .error, count: 1)),
            call("search", "search_files", .search, "TODO(auth)", ToolOutcome(key: .noMatches, tone: .neutral)),
            call("issue", "mcp_github_create_issue", .mcp, "Create issue", ToolOutcome(key: .failed, tone: .error, value: "Resource not accessible by integration")),
            call("skill", "skill_manage", .skill, "deploy-checklist", ToolOutcome(key: .pendingApproval, tone: .attention)),
            call("running", "session_send", .talaria, "session_send", ToolOutcome(key: .sent, tone: .neutral), done: false),
        ]
        for (name, style) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
            let window = try hostWindow(VStack(spacing: 0) { ForEach(calls) { ToolCallCardView(toolCall: $0) } }.padding(), size: CGSize(width: 390, height: 520)) { $0.userInterfaceStyle = style }
            for label in ["Sent", "Added 1 memory", "Exit 1", "No matches", "Resource not accessible by integration", "Waiting for approval"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: ", \(label)").isEmpty, "\(name): \(label)")
            }
            XCTAssertEqual(HostedAccessibility.elements(in: window, labelContaining: ", Sent").count, 1, "\(name): a running row shows no outcome")
            attachHostedScreenshot(window, name: "tool-row-outcomes-\(name)")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    /// TAL-2338: an open row's `{}` switches between its formatted rows and the server's raw arguments and result; Copy
    /// copies whichever shows and confirms, in light and dark.
    func testOpenToolRowTogglesTheRawViewAndCopiesWhatShows() async throws {
        let rawArgs = "{\n  \"limit\": 2\n}"
        let rawResult = "{\n  \"sessions\": [\n    \"Release chat\"\n  ],\n  \"token\": \"***\"\n}"
        let call = ToolCall(id: "raw-list", name: "session_list", preview: nil, args: nil,
                            argsFields: [ToolField(key: "limit", value: "2", multiline: false)], rawArgs: rawArgs, rawResult: rawResult,
                            kind: .talaria, target: "session_list",
                            resultView: ToolResultView(text: "{}", fields: [ToolField(key: "sessions", value: "- Release chat", multiline: false)]),
                            isCompleted: true)
        let copied = recordCopies()
        for (name, style) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
            let window = try hostWindow(VStack { ToolCallCardView(toolCall: call); Spacer() }.padding()
                .environment(\.chatTranscriptRowState, ChatTranscriptRowState()), size: CGSize(width: 390, height: 520)) { $0.userInterfaceStyle = style }
            if let header = HostedAccessibility.elements(in: window).first(where: { $0.accessibilityHint == "Double tap to expand details." }) {
                HostedAccessibility.activate(header)
            }
            HostedAccessibility.activate(try await requireElement(in: window, label: "Copy"))
            XCTAssertEqual(copied.last, "limit: 2\n\nsessions: - Release chat", name)
            _ = try await requireElement(in: window, label: "Copied")
            attachHostedScreenshot(window, name: "tool-row-formatted-\(name)")

            let toggle = try await requireElement(in: window, label: "Show raw")
            XCTAssertFalse(toggle.accessibilityTraits.contains(.selected), name)
            HostedAccessibility.activate(toggle)
            let pressed = try await requireElement(in: window, label: "Show formatted")
            XCTAssertTrue(pressed.accessibilityTraits.contains(.selected), name)
            _ = try await requireElement(in: window, label: rawArgs)
            _ = try await requireElement(in: window, label: rawResult)
            HostedAccessibility.activate(try await requireElement(in: window, label: "Copy raw"))
            XCTAssertEqual(copied.last, "\(rawArgs)\n\n\(rawResult)", name)
            attachHostedScreenshot(window, name: "tool-row-raw-\(name)")

            HostedAccessibility.activate(pressed)
            _ = try await requireElement(in: window, label: "Show raw")
            XCTAssertNil(HostedAccessibility.element(in: window, label: rawResult), name)
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    /// TAL-2341: a row the server marks `opens_raw` opens on its raw view, and its `{}` still switches to the formatted rows.
    func testRowTheServerOpensRawStartsInItsRawView() async throws {
        let rawArgs = "{\n  \"limit\": 2\n}"
        var call = ToolCall(id: "opens-raw", name: "session_list", preview: nil, args: nil,
                            argsFields: [ToolField(key: "limit", value: "2", multiline: false)], rawArgs: rawArgs,
                            kind: .talaria, target: "session_list", isCompleted: true)
        call.displayFlags.opensRaw = true
        let window = try hostWindow(VStack { ToolCallCardView(toolCall: call); Spacer() }.padding()
            .environment(\.chatTranscriptRowState, ChatTranscriptRowState()), size: CGSize(width: 390, height: 520))
        defer { window.isHidden = true; window.rootViewController = nil }
        HostedAccessibility.activate(try await requireElement(in: window) { $0.accessibilityHint == "Double tap to expand details." })
        _ = try await requireElement(in: window, label: rawArgs)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show formatted"))
        _ = try await requireElement(in: window, label: "Show raw")
        XCTAssertNil(HostedAccessibility.element(in: window, label: rawArgs))
    }

    /// TAL-2341: media the server keeps in details (`media_in_details`) stays out of the folded row and shows once it opens.
    func testMediaTheServerKeepsInDetailsShowsOnceTheRowOpens() async throws {
        var image = ToolCall(
            id: "image-details", name: "image_generate", preview: nil, args: nil, kind: .image, target: "",
            resultView: try JSONDecoder().decode(ToolResultView.self, from: Data(#"{"text": "{}", "media": [{"url": "./api/media?path=%2Fsrv%2Fcat.png&session_id=s1", "name": "cat.png", "mime": "image/png", "kind": "image"}]}"#.utf8)),
            isCompleted: true
        )
        image.displayFlags.mediaInDetails = true
        let media = ChatTranscriptMedia(cacheNamespace: "tool-media-\(UUID().uuidString)", loadImage: { _ in nil }, loadData: { _ in nil }, preview: { _ in })
        let window = try hostWindow(ScrollView { ToolCallCardView(toolCall: image).padding() }
            .environment(\.chatTranscriptRowState, ChatTranscriptRowState())
            .environment(\.chatTranscriptMedia, media), size: CGSize(width: 390, height: 600))
        defer { window.isHidden = true; window.rootViewController = nil }
        let header = try await requireElement(in: window) { $0.accessibilityHint == "Double tap to expand details." }
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "cat.png").isEmpty)
        HostedAccessibility.activate(header)
        let shown = await awaitCondition(timeout: 5) { !HostedAccessibility.elements(in: window, labelContaining: "cat.png").isEmpty }
        XCTAssertTrue(shown)
    }

    /// TAL-2335: on a narrow line the label gives way first; the outcome keeps its width up to 55% of the line.
    func testToolOutcomeLineTruncatesTheLabelFirst() {
        XCTAssertEqual(ToolOutcomeLineLayout.widths(line: 300, label: 120, outcome: 80).label, 120)
        XCTAssertEqual(ToolOutcomeLineLayout.widths(line: 300, label: 250, outcome: 80).label, 220)
        XCTAssertEqual(ToolOutcomeLineLayout.widths(line: 300, label: 250, outcome: 80).outcome, 80)
        XCTAssertEqual(ToolOutcomeLineLayout.widths(line: 300, label: 250, outcome: 260).outcome, 165)
        XCTAssertEqual(ToolOutcomeLineLayout.widths(line: 300, label: 250, outcome: 260).label, 135)
    }

    /// TAL-2323: an expanded read draws its path and numbered lines; a search its matches by file, each opening the file at its line.
    /// TAL-2594: an archive read that wrapped its long lines says so; an unwrapped read does not.
    func testExpandedReadAndSearchCardsDrawTheirLinesAndOpenTheFile() async throws {
        func view(_ json: String) throws -> ToolResultView { try JSONDecoder().decode(ToolResultView.self, from: Data(json.utf8)) }
        let read = ToolCall(
            id: "read-app", name: "read_file", preview: nil, args: nil, kind: .read, target: "src/app.ts",
            resultView: try view(#"{"text": "12|let a = 1", "file_excerpt": {"path": "src/app.ts", "focus_path": "src/app.ts", "language": "swift", "start_line": 12, "lines": [{"n": 12, "text": "let a = 1"}, {"n": 13, "text": "print(a)"}], "total_lines": 40, "truncated": true, "next_offset": 14}}"#),
            isCompleted: true
        )
        let search = ToolCall(
            id: "search-run", name: "search_files", preview: nil, args: nil, kind: .search, target: "run",
            resultView: try view(#"{"text": "{}", "matches": {"total": 6, "truncated": true, "files": [{"path": "src/a.ts", "focus_path": "src/a.ts", "matches": [{"line": 3, "text": "run()"}, {"line": 9, "text": "run(1)"}]}, {"path": "/elsewhere/b.ts", "count": 4, "matches": []}]}}"#),
            isCompleted: true
        )
        let archive = ToolCall(
            id: "read-archive", name: "read_file", preview: nil, args: nil, kind: .read, target: "call_1.json",
            resultView: try view(#"{"text": "1|aaaa", "file_excerpt": {"path": "/home/u/.hermes/cache/tool_results/call_1.json", "language": null, "start_line": 1, "lines": [{"n": 1, "text": "aaaa"}, {"n": 2, "text": "aaaa"}], "total_lines": 2, "truncated": false, "wrapped_at": 120}}"#),
            isCompleted: true
        )
        let suite = "TalariaTests.tool-files.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        var opened: [WorkspaceFileLink] = []
        let window = try hostWindow(
            ScrollView { VStack { ToolCallCardView(toolCall: read); ToolCallCardView(toolCall: search); ToolCallCardView(toolCall: archive) }.padding() }
                .defaultAppStorage(defaults)
                .chatEnvironmentAction(\.chatOpenWorkspaceFile) { opened.append($0) }
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = ["Open src/app.ts at line 12", "Line 12", "Line 13", "Stopped at line 13 of 40", "Open src/a.ts at line 9", "Matches: 4", "More results not shown", "Long lines wrapped at 120 characters"]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("12|") }, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("Open /elsewhere/b.ts") }, "\(labels())")
        XCTAssertEqual(labels().filter { $0.contains("wrapped") }.count, 1, "\(labels())")
        let match = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "Open src/a.ts at line 9").first)
        XCTAssertTrue(match.accessibilityActivate())
        XCTAssertEqual(opened, [WorkspaceFileLink(path: "src/a.ts", line: 9)])
        attachHostedScreenshot(window, name: "tool-read-and-search")
    }

    /// TAL-2324: an expanded web search draws its links, an X search its answer above its links, and an extract each page's
    /// excerpt or error; a link opens its page where transcript links open.
    func testExpandedWebCardsDrawTheirLinksAndPagesAndOpenTheURL() async throws {
        func view(_ json: String) throws -> ToolResultView { try JSONDecoder().decode(ToolResultView.self, from: Data(json.utf8)) }
        let search = ToolCall(
            id: "web-search", name: "web_search", preview: nil, args: nil, kind: .web, target: "hermes",
            resultView: try view(#"{"text": "{\"web\": []}", "links": {"items": [{"title": "Hermes Agent", "url": "https://www.example.com/hermes", "domain": "example.com", "snippet": "An open agent."}, {"title": "Docs", "url": "https://docs.example.org/start", "domain": "docs.example.org"}]}}"#),
            isCompleted: true
        )
        let x = ToolCall(
            id: "x-search", name: "x_search", preview: nil, args: nil, kind: .search, target: "hermes",
            resultView: try view(#"{"text": "{}", "links": {"answer": "People **like** it.", "items": [{"title": "Post by b", "url": "https://x.com/b/status/2", "domain": "x.com"}]}}"#),
            isCompleted: true
        )
        let extract = ToolCall(
            id: "web-extract", name: "web_extract", preview: nil, args: nil, kind: .web, target: "example.com",
            resultView: try view(#"{"text": "[]", "pages": [{"url": "https://example.com/hermes", "domain": "example.com", "title": "Hermes", "excerpt": "An open agent for your server."}, {"url": "https://blocked.example/", "domain": "blocked.example", "title": "https://blocked.example/", "excerpt": "", "error": "Blocked by website policy"}]}"#),
            isCompleted: true
        )
        let suite = "TalariaTests.tool-web.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        var opened: [URL] = []
        let window = try hostWindow(
            ScrollView { VStack { ToolCallCardView(toolCall: search); ToolCallCardView(toolCall: x); ToolCallCardView(toolCall: extract) }.padding() }
                .defaultAppStorage(defaults)
                .environment(\.openURL, OpenURLAction { opened.append($0); return .handled }),
            size: CGSize(width: 390, height: 1100)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = ["Open Hermes Agent", "example.com", "An open agent.", "Open Docs", "People", "Open Post by b", "Open Hermes", "An open agent for your server.", "Blocked by website policy"]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("**") || $0.contains("\"web\"") }, "\(labels())")
        let link = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "Open Hermes Agent").first)
        XCTAssertTrue(link.accessibilityActivate())
        XCTAssertEqual(opened, [URL(string: "https://www.example.com/hermes")!])
        attachHostedScreenshot(window, name: "tool-web-links-and-pages")
    }

    /// TAL-2326: an expanded memory, past-chat, job, connection or clarify call draws its rows (never its JSON) under its own
    /// icon and words, a viewed skill its formatted text, and a linked row opens that Talaria page through the app's router.
    func testExpandedRowsCardsDrawTheirRowsAndOpenTheirTalariaPage() async throws {
        func view(_ json: String) throws -> ToolResultView { try JSONDecoder().decode(ToolResultView.self, from: Data(json.utf8)) }
        let search = ToolCall(
            id: "rows-search", name: "session_search", preview: nil, args: nil, kind: .session, target: "deploy",
            resultView: try view(#"{"text": "{\"results\": []}", "rows": {"title": "deploy", "rows": [{"label": "Deploy fix", "detail": "November 16 · the deploy failed", "link": {"kind": "session", "id": "past-1"}}]}}"#),
            isCompleted: true
        )
        let cron = ToolCall(
            id: "rows-cron", name: "cronjob_manage", preview: nil, args: nil, kind: .schedule, target: "job-1",
            resultView: try view(#"{"text": "{}", "rows": {"title": "Paused", "rows": [{"label": "Morning digest", "detail": "every day at 09:00 · paused", "status": "error", "link": {"kind": "crons", "id": "job-1"}}]}}"#),
            isCompleted: true
        )
        let connect = ToolCall(
            id: "rows-connect", name: "manage_connections", preview: nil, args: nil, kind: .connection, target: "",
            resultView: try view(#"{"text": "{}", "rows": {"rows": [{"label": "github", "detail": "initiated", "status": "pending", "link": {"kind": "connectors"}}]}}"#),
            isCompleted: true
        )
        let question = ToolCall(
            id: "rows-clarify", name: "clarify", preview: nil, args: nil, kind: .question, target: "",
            resultView: try view(#"{"text": "{}", "rows": {"rows": [{"label": "Which branch?", "detail": "dev"}]}}"#),
            isCompleted: true
        )
        let skill = ToolCall(
            id: "rows-skill", name: "skill_view", preview: nil, args: nil, kind: .skill, target: "pdf",
            resultView: try view(#"{"text": "PDF", "rows": {"title": "pdf", "rows": [{"label": "Setup needed", "detail": "Set $PDF_KEY.", "status": "warn"}], "markdown": "Use **pdftotext** here."}}"#),
            isCompleted: true
        )
        let suite = "TalariaTests.tool-rows.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        var opened: [URL] = []
        let window = try hostWindow(
            ScrollView {
                VStack {
                    ToolCallCardView(toolCall: search); ToolCallCardView(toolCall: cron); ToolCallCardView(toolCall: connect)
                    ToolCallCardView(toolCall: question); ToolCallCardView(toolCall: skill)
                }.padding()
            }
            .defaultAppStorage(defaults)
            .environment(\.openURL, OpenURLAction { opened.append($0); return .handled }),
            size: CGSize(width: 390, height: 1300)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = [
            "Searched past chats for deploy", "Deploy fix", "Managed a scheduled job", "Morning digest", "Managed connections", "github",
            "Asked a question", "Which branch?", "dev", "Setup needed", "here",
        ]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("**") || $0.contains("\"results\"") }, "\(labels())")
        for (label, destination) in [("Deploy fix", TalariaDeepLink.sessionURL(sessionID: "past-1")), ("Morning digest", TalariaDeepLink.sectionURL(.tasks)), ("github", TalariaDeepLink.sectionURL(.tools))] {
            let row = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: label).first, label)
            XCTAssertTrue(row.accessibilityActivate(), label)
            XCTAssertEqual(opened.last, destination, label)
        }
        XCTAssertEqual(opened.count, 3)
        attachHostedScreenshot(window, name: "tool-rows-expanded")
    }

    /// TAL-2027: an answered question's rows show under its folded row; a clipped exchange shows its whole rows there once
    /// the open row's Show full output fetched them.
    func testAClippedAnsweredQuestionShowsItsWholeRowsInViewOnceFetched() async throws {
        func view(questions: Int) throws -> ToolResultView {
            let rows = (1...questions).map { #"{"label": "Question \#($0)?", "detail": "Answer \#($0)"}"# }.joined(separator: ", ")
            return try JSONDecoder().decode(ToolResultView.self, from: Data(#"{"rows": {"rows": [\#(rows)]}}"#.utf8))
        }
        var question = ToolCall(id: "clipped-clarify", name: "clarify", preview: nil, args: nil, kind: .question, target: "",
                                resultView: try view(questions: 2), isCompleted: true)
        question.resultTruncated = true
        question.displayFlags.showsCard = true
        let whole = ToolResultResponse(result: "{}", resultView: try view(questions: 5), rawResult: "{}")
        let window = try hostWindow(ScrollView { ToolCallCardView(toolCall: question).padding() }
            .chatEnvironmentAction(\.chatFullToolResultLoader) { _ in { whole } }
            .environment(\.chatTranscriptRowState, ChatTranscriptRowState()), size: CGSize(width: 390, height: 900))
        defer { window.isHidden = true; window.rootViewController = nil }
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("Question 2?") == true }
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Question 5?").isEmpty)
        HostedAccessibility.activate(try await requireElement(in: window) { $0.accessibilityHint == "Double tap to expand details." })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show full output"))
        let fetched = await awaitCondition { !HostedAccessibility.elements(in: window, labelContaining: "Question 5?").isEmpty }
        XCTAssertTrue(fetched, "The fetched rows do not show in view")
        XCTAssertEqual(HostedAccessibility.elements(in: window, labelContaining: "Question 5?").count, 1, "The open row repeats the rows")
    }

    /// TAL-2327: an expanded Kanban call reads as its verb and task under the Kanban icon, draws the tasks it touched as rows
    /// (never its JSON), and a task row opens that card on its board through the app's router.
    func testExpandedKanbanCardDrawsItsTasksAndOpensTheCard() async throws {
        func view(_ json: String) throws -> ToolResultView { try JSONDecoder().decode(ToolResultView.self, from: Data(json.utf8)) }
        let complete = ToolCall(
            id: "kanban-complete", name: "kanban_complete", preview: nil, args: nil, kind: .kanban, verb: .complete, target: "t_1",
            resultView: try view(#"{"text": "{\"ok\": true}", "rows": {"rows": [{"label": "Fix login", "detail": "done", "link": {"kind": "kanban_task", "id": "t_1", "board": "ops"}}]}}"#),
            isCompleted: true
        )
        let list = ToolCall(
            id: "kanban-list", name: "kanban_list", preview: nil, args: nil, kind: .kanban, verb: .list, target: "",
            resultView: try view(#"{"text": "{\"tasks\": []}", "rows": {"rows": [{"label": "Write release notes", "detail": "ready · scout", "link": {"kind": "kanban_task", "id": "t_2"}}]}}"#),
            isCompleted: true
        )
        let suite = "TalariaTests.tool-kanban.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        var opened: [URL] = []
        let window = try hostWindow(
            ScrollView { VStack { ToolCallCardView(toolCall: complete); ToolCallCardView(toolCall: list) }.padding() }
                .defaultAppStorage(defaults)
                .environment(\.openURL, OpenURLAction { opened.append($0); return .handled }),
            size: CGSize(width: 390, height: 600)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = ["Completed t_1", "Fix login", "Listed tasks", "Write release notes"]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("\"ok\"") || $0.contains("\"tasks\"") }, "\(labels())")
        for (label, destination) in [("Fix login", TalariaDeepLink.kanbanCardURL(cardID: "t_1", board: "ops")), ("Write release notes", TalariaDeepLink.kanbanCardURL(cardID: "t_2"))] {
            let row = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: label).first, label)
            XCTAssertTrue(row.accessibilityActivate(), label)
            XCTAssertEqual(opened.last, destination, label)
        }
        attachHostedScreenshot(window, name: "tool-kanban-rows")
    }

    /// TAL-2333: a delegation row lists each subagent under its counts with its status, goal and seconds once finished, and
    /// each row opens its unit in the Background tasks sheet.
    func testDelegationRowListsEachSubagentAndOpensItsUnit() async throws {
        var call = ToolCall(id: "delegate", name: "delegate_task", preview: nil, args: nil, kind: .delegate, target: "", isCompleted: true)
        call.background = BackgroundLink(taskIds: ["call-1-1", "call-1-2", "call-1-3"], status: .running,
                                         agents: BackgroundWorkTask.Agents(total: 3, completed: 1, failed: 1, running: 1), agentsDetail: [
            .init(taskId: "call-1-1", goal: "Write docs", status: .completed, duration: 75, summary: "Docs written."),
            .init(taskId: "call-1-2", goal: "Write tests", status: .failed, duration: 4),
            .init(taskId: "call-1-3", goal: "Run tests", status: .running),
        ])
        var opened: [String] = []
        let window = try hostWindow(
            ScrollView { ToolCallCardView(toolCall: call).padding() }
                .chatEnvironmentAction(\.chatOpenBackgroundTask) { opened.append($0) },
            size: CGSize(width: 390, height: 400)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = ["1 of 3 done · 1 failed", "Done, Write docs, Docs written., 1 minute, 15 seconds", "Failed, Write tests, 4 seconds", "Running, Run tests"]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        attachHostedScreenshot(window, name: "tool-delegate-agents")
        let row = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "Write tests").first)
        XCTAssertTrue(row.accessibilityActivate())
        XCTAssertEqual(opened, ["call-1-2"])
    }

    /// TAL-2330: an MCP call reads as its app and action under the MCP symbol; a connector call under its catalog logo, and
    /// under the connector symbol when it has none.
    func testMCPAndConnectorCardsReadAsTheirAppAndAction() async throws {
        let logo = FileManager.default.temporaryDirectory.appendingPathComponent("gmail-\(UUID().uuidString).png")
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32))
        try renderer.pngData { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }.write(to: logo)
        defer { try? FileManager.default.removeItem(at: logo) }
        let calls = [
            ToolCall(id: "mcp", name: "mcp__github__create_issue", preview: nil, args: nil, kind: .mcp, app: ToolApp(name: "GitHub"), target: "Create issue", isCompleted: true),
            ToolCall(id: "mail", name: "connectors__gmail__GMAIL_SEND_EMAIL", preview: nil, args: nil, kind: .connector, app: ToolApp(name: "Gmail", logoURL: logo), target: "Send email (work)", isCompleted: true),
            ToolCall(id: "notion", name: "connectors__notion__NOTION_CREATE_PAGE", preview: nil, args: nil, kind: .connector, app: ToolApp(name: "Notion"), target: "Create page", isCompleted: true),
        ]
        let window = try hostWindow(
            ScrollView { VStack { ForEach(calls) { ToolCallCardView(toolCall: $0) } }.padding() },
            size: CGSize(width: 390, height: 400)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = ["GitHub · Create issue", "Gmail · Send email (work)", "Notion · Create page"]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        // The logo loads off the main thread; give it a moment to draw before the screenshot.
        _ = await awaitCondition(timeout: 2) { false }
        attachHostedScreenshot(window, name: "tool-mcp-connector")
    }

    /// TAL-2328: an expanded browser-code call reads as its comment line under the browser icon and draws its code above
    /// its output; a desktop capture reads as its verb under the computer icon and draws its rows, never its JSON.
    func testExpandedBrowserAndComputerCardsDrawTheirCodeAndRows() async throws {
        func view(_ json: String) throws -> ToolResultView { try JSONDecoder().decode(ToolResultView.self, from: Data(json.utf8)) }
        let exec = ToolCall(
            id: "browser-exec", name: "browser_exec", preview: nil, args: nil, kind: .browser, verb: .run, target: "Open the pricing page",
            resultView: try view(##"{"file_excerpt": {"path": "", "language": "python", "start_line": 1, "lines": [{"n": 1, "text": "# Open the pricing page"}, {"n": 2, "text": "goto(\"https://example.com/pricing\")"}], "total_lines": 2, "truncated": false}, "stdout": "Pricing: $10/month"}"##),
            isCompleted: true
        )
        let capture = ToolCall(
            id: "computer-capture", name: "computer_use", preview: nil, args: nil, kind: .computer, verb: .capture, target: "",
            resultView: try view(#"{"text": "{\"mode\": \"som\"}", "rows": {"title": "Safari", "rows": [{"label": "Safari", "detail": "Pricing · 2 elements"}]}}"#),
            isCompleted: true
        )
        let suite = "TalariaTests.tool-browser.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        let window = try hostWindow(
            ScrollView { VStack { ToolCallCardView(toolCall: exec); ToolCallCardView(toolCall: capture) }.padding() }
                .defaultAppStorage(defaults),
            size: CGSize(width: 390, height: 700)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let expected = ["Ran Open the pricing page", "goto(\"https://example.com/pricing\")", "Pricing: $10/month", "Captured the screen", "Pricing · 2 elements"]
        let drawn = await awaitCondition(timeout: 5) { expected.allSatisfy { label in labels().contains { $0.contains(label) } } }
        XCTAssertTrue(drawn, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("\"mode\"") }, "\(labels())")
        XCTAssertEqual(AssistantActivitySummary.icon(for: exec), "macwindow")
        XCTAssertEqual(AssistantActivitySummary.icon(for: capture), "desktopcomputer")
        attachHostedScreenshot(window, name: "tool-browser-computer")
    }

    /// TAL-2325: a generated image shows under its call without opening it, loads through the transcript's media loader and
    /// opens the preview; an analysis shows as formatted text once the call opens.
    func testMediaCardShowsItsImageAndAnAnalysisItsText() async throws {
        func view(_ json: String) throws -> ToolResultView { try JSONDecoder().decode(ToolResultView.self, from: Data(json.utf8)) }
        let image = ToolCall(
            id: "image", name: "image_generate", preview: nil, args: nil, kind: .image, target: "",
            resultView: try view(#"{"text": "{}", "media": [{"url": "./api/media?path=%2Fsrv%2Fcat.png&session_id=s1", "name": "cat.png", "mime": "image/png", "kind": "image"}]}"#),
            isCompleted: true
        )
        let analysis = ToolCall(
            id: "vision", name: "vision_analyze", preview: nil, args: nil, kind: .imageAnalysis, target: "",
            resultView: try view(#"{"text": "{\"analysis\": \"A cat.\"}", "analysis": "A **cat** on a sofa."}"#),
            isCompleted: true
        )
        let png = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        var loaded: [String] = []
        var previewed: [String] = []
        let media = ChatTranscriptMedia(
            cacheNamespace: "tool-media-\(UUID().uuidString)",
            loadImage: { loaded.append($0.url); return png },
            loadData: { _ in nil },
            preview: { previewed.append($0.name) }
        )
        let window = try hostWindow(
            ScrollView { VStack { ToolCallCardView(toolCall: image); ToolCallCardView(toolCall: analysis) }.padding() }
                .environment(\.chatTranscriptMedia, media),
            size: CGSize(width: 390, height: 500)
        )
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let shown = await awaitCondition(timeout: 5) { labels().contains { $0.contains("Open media image cat.png") } && !loaded.isEmpty }
        XCTAssertTrue(shown, "\(labels())")
        XCTAssertEqual(loaded, ["./api/media?path=%2Fsrv%2Fcat.png&session_id=s1"])
        XCTAssertTrue(labels().contains { $0.contains("Generated an image") }, "\(labels())")
        let thumbnail = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "Open media image cat.png").first)
        XCTAssertTrue(thumbnail.accessibilityActivate())
        XCTAssertEqual(previewed, ["cat.png"])
        // Folded, the analysis stays out of view; opened, it reads as formatted text, never its JSON.
        XCTAssertFalse(labels().contains { $0.contains("on a sofa") }, "\(labels())")
        attachHostedScreenshot(window, name: "tool-media-folded")
        let suite = "TalariaTests.tool-media.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        let expanded = try hostWindow(
            ScrollView { VStack { ToolCallCardView(toolCall: image); ToolCallCardView(toolCall: analysis) }.padding() }
                .defaultAppStorage(defaults)
                .environment(\.chatTranscriptMedia, media),
            size: CGSize(width: 390, height: 900)
        )
        let expandedLabels = { HostedAccessibility.elements(in: expanded).compactMap { $0.accessibilityLabel } }
        let opened = await awaitCondition(timeout: 5) { expandedLabels().contains { $0.contains("on a sofa") } }
        XCTAssertTrue(opened, "\(expandedLabels())")
        XCTAssertFalse(expandedLabels().contains { $0.contains("**") || $0.contains("\"analysis\"") }, "\(expandedLabels())")
        attachHostedScreenshot(expanded, name: "tool-media-and-analysis-expanded")
    }

    /// TAL-2318: an expanded call draws the server's argument and result rows, not its raw JSON.
    func testExpandedToolCardDrawsTheServerRows() async throws {
        let call = ToolCall(
            id: "rows-list", name: "session_list", preview: #"{"total": 2}"#,
            args: ["limit": .number(5)],
            argsFields: [ToolField(key: "limit", value: "5", multiline: false), ToolField(key: "sources", value: "- cli\n- web", multiline: true)],
            kind: .talaria, target: "session_list",
            resultView: ToolResultView(text: #"{"total": 2}"#, fields: [ToolField(key: "total", value: "2", multiline: false), ToolField(key: "has_more", value: "false", multiline: false)]),
            isCompleted: true
        )
        let suite = "TalariaTests.tool-rows.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey)
        let window = try hostWindow(ScrollView { ToolCallCardView(toolCall: call).padding() }.defaultAppStorage(defaults))
        let labels = { HostedAccessibility.elements(in: window).compactMap { $0.accessibilityLabel } }
        let drawn = await awaitCondition(timeout: 5) { ["limit", "sources", "total", "has_more"].allSatisfy(labels().contains) }
        XCTAssertTrue(drawn, "\(labels())")
        XCTAssertFalse(labels().contains { $0.contains("{") }, "\(labels())")
        attachHostedScreenshot(window, name: "tool-rows-session-list")
        window.isHidden = true
        window.rootViewController = nil
    }

    /// TAL-1241: a running tool's glow keeps sweeping while its content is evaluated once, not every display frame.
    func testRunningToolGlowSweepsWithoutPerFrameEvaluation() throws {
        let evaluations = ChatBodyEvaluationRecorder()
        let calls = (1...3).map { ToolCall(id: "glow-\($0)", name: "terminal", preview: nil, args: nil) }
        let window = try hostWindow(
            VStack { ForEach(calls) { ToolCallCardView(toolCall: $0) } }
                .environment(\._accessibilityReduceMotion, false)
                .environment(\.chatBodyEvaluation, evaluations),
            animationsEnabled: true
        )
        func image() -> Data? {
            UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }.pngData()
        }
        evaluations.reset()
        let start = image()
        settle(1)
        XCTAssertLessThanOrEqual(evaluations.counts["activityGlow", default: 0], calls.count,
                                 "A running tool's glow re-evaluated its content per frame")
        XCTAssertNotEqual(image(), start, "A running tool's glow stood still")
    }

    /// Mounting a buffered target is not arrival; wait before interacting with it.
    private func navigateTranscript(to id: String, anchor: UnitPoint, using controller: ChatScrollPositionController,
                                    afterRequest: () -> Void = {}) async throws {
        controller.cancelPreservation()
        let navigate = try XCTUnwrap(controller.onHoldAnchor, "The transcript must register its navigation owner")
        navigate(id, anchor)
        afterRequest()
        let arrived = await awaitCondition {
            !controller.isNavigating && !controller.isPreservingPosition && !controller.isRealizingRows
        }
        XCTAssertTrue(arrived, "The requested reader must finish navigation and realization before fixture interaction; navigating \(controller.isNavigating), preserving \(controller.isPreservingPosition), realizing \(controller.isRealizingRows), top \(String(describing: controller.viewportTop))")
    }

    private func transcriptScrollView(in window: UIWindow) throws -> UIScrollView {
        var scroll: UIScrollView?
        waitUntil {
            scroll = window.firstView(ofType: ChatMessageMenuHostView.self)?.superview.flatMap {
                sequence(first: $0, next: \.superview).first { $0 is UIScrollView } as? UIScrollView
            }
            return scroll != nil
        }
        return try XCTUnwrap(scroll, "The transcript's native scroll handler did not attach")
    }
}

@MainActor @Observable
private final class RecycledBodyFixture {
    var showsBody = true
    let rowState = ChatTranscriptRowState()
    let tool: ToolCall?
    @ObservationIgnored private var toolResultContinuation: CheckedContinuation<Void, Never>?
    var toolResultCalls = 0
    var isToolResultPending: Bool { toolResultContinuation != nil }
    init(tool: ToolCall? = nil) { self.tool = tool }

    func toolResult() async -> ToolResultResponse {
        toolResultCalls += 1
        await withCheckedContinuation { toolResultContinuation = $0 }
        return ToolResultResponse(result: "Full retained tool output", resultView: ToolResultView(text: "Full retained tool output"),
                                  rawResult: "Full retained tool output")
    }

    func releaseToolResult() {
        let continuation = toolResultContinuation
        toolResultContinuation = nil
        continuation?.resume()
    }
}

private struct RecycledBodyView: View {
    let state: RecycledBodyFixture
    var body: some View {
        if state.showsBody {
            Group {
                if let tool = state.tool {
                    ToolCallCardView(toolCall: tool)
                        .chatEnvironmentAction(\.chatFullToolResultLoader) { _ in { await state.toolResult() } }
                } else {
                    MessageBubbleView(message: ChatMessage(role: "user", content: "Full retained fixture body", timestamp: nil,
                                                          messageId: "retained-body", displayExcerpt: "Excerpt"))
                }
            }
            .environment(\.chatTranscriptRowState, state.rowState)
        }
    }
}


@MainActor
final class ApprovalRequestContentTests: XCTestCase {
    /// TAL-2333: an approval heads its card with the held call's icon and label as its tool row reads them; a write shows
    /// its arguments as key/value rows in place of the command, and a shell call keeps its command.
    func testAnApprovalHeadsWithItsHeldCallAndShowsItsArgumentsAsRows() throws {
        let write = ToolCall(id: "call-write", name: "write_file", preview: nil, args: nil,
                             argsFields: [ToolField(key: "path", value: "/etc/hosts", multiline: false), ToolField(key: "content", value: "127.0.0.1 example", multiline: false)],
                             kind: .write, target: "/etc/hosts")
        let shell = ToolCall(id: "call-push", name: "terminal", preview: nil, args: nil, kind: .shell, target: "git push --force")
        func host(_ tool: ToolCall, command: String) throws -> UIWindow {
            let pending = PendingApproval(approvalId: "approval-\(tool.id)", command: command, description: "Protected path", tool: tool)
            return try hostWindow(ApprovalRequestContent(
                prompt: ApprovalPromptState(sessionID: "synthetic-tool-approval", pending: pending, pendingCount: 1),
                isResponding: false, errorMessage: nil, onChoice: { _ in }, onSkipAll: {}, onCollapse: {}
            ), size: HostedSize.phone)
        }
        let written = try host(write, command: "write /etc/hosts")
        attachHostedScreenshot(written, name: "approval-tool-write")
        XCTAssertNotNil(HostedAccessibility.element(in: written, label: "Approval required: Editing /etc/hosts"))
        XCTAssertNil(HostedAccessibility.element(in: written, label: "Approval required"))
        XCTAssertNotNil(HostedAccessibility.element(in: written, label: "127.0.0.1 example"))
        XCTAssertNil(HostedAccessibility.element(in: written, label: "write /etc/hosts"))
        let pushed = try host(shell, command: "git push --force")
        attachHostedScreenshot(pushed, name: "approval-tool-shell")
        XCTAssertNotNil(HostedAccessibility.element(in: pushed, label: "Approval required: Running git push --force"))
        XCTAssertNotNil(HostedAccessibility.element(in: pushed, label: "git push --force"))
    }

    /// TAL-974: the card's "?" says what Allow session and Always allow cover in the sentence Web's help shows for the
    /// same approval, from the shared `contracts/fixtures/tool-approval-and-agents.json`, and never shows the Agent's raw keys.
    func testAnApprovalSaysWhatAllowSessionAndAlwaysAllowCoverAsWebDoes() async throws {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("tool-approval-and-agents")) as? [String: Any])
        for entry in try XCTUnwrap(root["approval_scopes"] as? [[String: Any]]) {
            let pending = try JSONDecoder().decode(PendingApproval.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(entry["pending"])))
            let window = try hostWindow(ApprovalRequestContent(
                prompt: ApprovalPromptState(sessionID: "synthetic-scope-session", pending: pending, pendingCount: 1),
                isResponding: false, errorMessage: nil, onChoice: { _ in }, onSkipAll: {}, onCollapse: {}
            ), size: HostedSize.phone)
            let id = pending.id
            XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "covers").isEmpty, "\(id) shows its scope as sub-text")
            XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Pattern keys").isEmpty, id)
            // A shell key is the Agent's own danger description, which the card shows as the description.
            for key in pending.displayPatternKeys where key != pending.description {
                XCTAssertNil(HostedAccessibility.element(in: window, label: key), "\(id) shows its raw key \(key)")
            }
            let help = HostedAccessibility.element(in: window, label: "What Allow session and Always allow cover")
            guard let sentence = entry["sentence"] as? String else {
                XCTAssertNil(help, "\(id) offers help for a one-time prompt")
                continue
            }
            XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(help, id)), id)
            func alert() -> UIAlertController? {
                var controller = window.rootViewController
                while let presented = controller?.presentedViewController { controller = presented }
                return controller as? UIAlertController
            }
            let shown = await awaitCondition { alert()?.message == sentence }
            XCTAssertTrue(shown, "\(id) help shows \(alert()?.message ?? "nothing"), not \(sentence)")
            if id == "scope-rule" { attachHostedScreenshot(window, name: "approval-scope-tool-rule-help") }
            window.rootViewController?.dismiss(animated: false)
        }
    }

    /// TAL-2022: the card shows the server's "in plain words" line under the command in each state, from the shared
    /// `contracts/fixtures/tool-approval-and-agents.json` Web's card test reads; only a summary still being written is busy.
    func testAnApprovalShowsTheServersPlainWordsLineInEachState() throws {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("tool-approval-and-agents")) as? [String: Any])
        let shown = [
            "explain-pending": "In plain words (AI summary): Summarizing…",
            "explain-ready": "In plain words (AI summary): Deletes every .log file older than seven days in this folder and its subfolders.",
            "explain-unavailable": "In plain words (AI summary): No summary available.",
        ]
        let entries = try XCTUnwrap(root["approval_explanations"] as? [[String: Any]])
        XCTAssertEqual(Set(entries.compactMap { $0["approval_id"] as? String }), Set(shown.keys))
        for entry in entries {
            let pending = try JSONDecoder().decode(PendingApproval.self, from: JSONSerialization.data(withJSONObject: entry))
            let window = try hostWindow(ApprovalRequestContent(
                prompt: ApprovalPromptState(sessionID: "synthetic-explain-session", pending: pending, pendingCount: 1),
                isResponding: false, errorMessage: nil, onChoice: { _ in }, onSkipAll: {}, onCollapse: {}
            ), size: HostedSize.phone)
            let id = pending.id
            let line = try XCTUnwrap(HostedAccessibility.element(in: window, identifier: "approval-explanation"), id)
            XCTAssertEqual(line.accessibilityLabel, shown[id], id)
            XCTAssertEqual(window.containsView(ofType: UIActivityIndicatorView.self), id == "explain-pending", id)
            if id == "explain-ready" { attachHostedScreenshot(window, name: "approval-explanation-ready") }
            window.isHidden = true
        }
    }

    func testAnApprovalOfferingNoChoiceSaysSoAndOffersNoAnswer() throws {
        let pending = PendingApproval(approvalId: "synthetic-no-choice-approval", command: "echo fixture",
                                      description: "Run the fixture command?", allowedChoices: [], canEnableYolo: false)
        let window = try hostWindow(ApprovalRequestContent(
            prompt: ApprovalPromptState(sessionID: "synthetic-no-choice-session", pending: pending, pendingCount: 1),
            isResponding: false, errorMessage: nil, onChoice: { _ in }, onSkipAll: {}, onCollapse: {}
        ), size: HostedSize.phone)
        attachHostedScreenshot(window, name: "approval-no-choices")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "This approval can't be answered here."))
        for title in ["Allow once", "Allow session", "Always allow", "Deny", "Skip all this session"] {
            XCTAssertNil(HostedAccessibility.element(in: window, label: title), title)
        }
    }
}

/// TAL-968: the chat's bar draws its own background, so transcript text scrolled under the title never shows through.
/// The transcript scrolls inside the chat, so the bar stays in its scroll-edge appearance whatever is under it.
@MainActor
final class ChatNavigationBackgroundTests: XCTestCase {
    func testChatBarDrawsMaterialBehindTheTitle() async throws {
        let bar = try await chatBar(reduceTransparency: false)
        if #available(iOS 26, *) {
            XCTAssertTrue(bar.appearance.backgroundEffect != nil, "The chat bar must draw a material behind its title")
        } else {
            XCTAssertEqual(bar.background, bar.systemBackground, "Before iOS 26 the chat bar is opaque")
        }
    }

    func testChatBarIsOpaqueWithReduceTransparency() async throws {
        let bar = try await chatBar(reduceTransparency: true)
        XCTAssertNil(bar.appearance.backgroundEffect, "Reduce Transparency must not blur transcript text behind the title")
        XCTAssertEqual(bar.background, bar.systemBackground, "Reduce Transparency makes the chat bar opaque")
    }

    /// The appearance the chat's bar shows at the scroll edge once a long transcript fills the chat, with its
    /// background and the system background resolved for the window.
    private func chatBar(reduceTransparency: Bool) async throws
        -> (appearance: UINavigationBarAppearance, background: UIColor?, systemBackground: UIColor) {
        let fixture = try FixtureApp(["--ui-test-long-bodies"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(fixture.chat(session).environment(\._accessibilityReduceTransparency, reduceTransparency))
        _ = try await requireElement(in: window, label: "Short reply 25.")
        attachHostedScreenshot(window, name: reduceTransparency ? "chat-bar-reduce-transparency" : "chat-bar")
        let navigation = try XCTUnwrap(Self.navigationController(under: window.rootViewController))
        let page = try XCTUnwrap(navigation.topViewController)
        let appearance = page.navigationItem.scrollEdgeAppearance ?? navigation.navigationBar.scrollEdgeAppearance
            ?? navigation.navigationBar.standardAppearance
        let traits = window.traitCollection
        return (appearance, appearance.backgroundColor?.resolvedColor(with: traits), UIColor.systemBackground.resolvedColor(with: traits))
    }

    private static func navigationController(under controller: UIViewController?) -> UINavigationController? {
        guard let controller else { return nil }
        if let navigation = controller as? UINavigationController { return navigation }
        return controller.children.lazy.compactMap { navigationController(under: $0) }.first
    }
}
