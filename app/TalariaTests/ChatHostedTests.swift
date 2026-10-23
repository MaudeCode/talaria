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

    func testTabletopPartitionsTranscriptAndComposerWithoutLosingTheDraft() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let fold = CGRect(x: -100, y: 330, width: 2000, height: 40)
        let recorder = ChatBodyEvaluationRecorder()
        var transcriptFrame: CGRect { recorder.transcriptFrame }
        let chat = fixture.chat(session).environment(\.chatBodyEvaluation, recorder)
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
        let partitioned = await awaitCondition {
            transcriptFrame.maxY <= foldInWindow.minY + 1
        }
        XCTAssertTrue(partitioned, "The tabletop transcript still extends below the horizontal fold: \(transcriptFrame), fold \(foldInWindow)")
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
        let chat = fixture.chat(session).environment(\.layoutDirection, .rightToLeft)
        let window = try hostWindow(FoldHost(content: AnyView(chat),
            division: CGRect(x: 300, y: -100, width: 40, height: 2000)),
            size: CGSize(width: 900, height: 700))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        try await typeIntoComposer("Retained RTL draft", in: window)
        let loadedEditor = await composerTextView(in: window)
        let editor = try XCTUnwrap(loadedEditor)
        XCTAssertGreaterThan(editor.convert(editor.bounds, to: window).maxX, 340)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Toggle fixture fold"))
        let displaced = await awaitCondition { editor.convert(editor.bounds, to: window).maxX <= 300 }
        XCTAssertTrue(displaced, "The RTL composer must fit left of the physical division")
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertLessThanOrEqual(window.convert(send.accessibilityFrame, from: nil).maxX, 300)
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
        _ = try await requireElement(in: window, label: "Select reasoning effort")
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
            ChatView(session: summary, server: UITestFixtureEnvironment.serverURL, onAPIError: { _ in },
                     initialDraft: "Keep this draft", loadsInitialMessages: false, viewModel: viewModel)
        }.environment(\.chatBodyEvaluation, evaluations)
            .modelContainer(fixture.cache), size: size)
        let configured = await awaitCondition { viewModel.isSessionApprovalBypassEnabled }
        XCTAssertTrue(configured, "The hosted chat's startup must finish before measuring reveal work")
        let started = await viewModel.sendMessage("Stream a reply")
        XCTAssertTrue(started)
        stream.emit(.token("Opening "))
        let opened = await awaitCondition { viewModel.messages.last?.content == "Opening " }
        XCTAssertTrue(opened)
        // Let main-actor startup work finish before resetting the recorder.
        try await Task.sleep(for: .milliseconds(500))
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
            try await Task.sleep(for: .milliseconds(50))
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
            settle(0.5)
            let refreshedAlert = await presentedAlert(in: window)
            let warning = try XCTUnwrap(refreshedAlert, "The server's warning \(update) never appeared")
            let title = update == 3 ? "Context changed" : "Context changed \(update)"
            XCTAssertEqual(warning.message, "\(title)\n\nThe next reply will reread the updated context.")
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
        let window = try await hostFixtureChat(["--ui-test-chat-controls"])
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("/queue First queued message", in: window)
        try await sendFromComposer("/queue Second queued message", in: window)
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

    func testTranscriptScrollViewWaitsForNativeAttachmentAfterTextAppears() throws {
        let window = try hostWindow(Text("History answer 1999."))
        let scroll = UIScrollView(frame: window.bounds)
        let host = ChatMessageMenuHostView(registry: ChatMessageMenuRegistry())
        let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: false) { _ in
            MainActor.assumeIsolated {
                scroll.addSubview(host)
                window.addSubview(scroll)
            }
        }
        defer { timer.invalidate() }
        XCTAssertTrue(try transcriptScrollView(in: window) === scroll,
                      "Visible text can precede the transcript's native attachment")
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
        try await Task.sleep(for: .milliseconds(200))
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
            try await Task.sleep(for: .milliseconds(1_500))
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
                try await Task.sleep(for: .milliseconds(200))
                // A tall answer's first paragraph can be above the viewport;
                // measure an actually visible piece of that same message.
                let nextPoint = try XCTUnwrap(stride(from: viewport.minY + 80, to: viewport.maxY - 80, by: 10)
                    .map { CGPoint(x: viewport.midX, y: $0) }
                    .first { registry.hit(at: scroll.convert($0, from: window), in: scroll)?.content.messageID == nextReaderID })
                let nextBefore = try XCTUnwrap(registry.hit(at: scroll.convert(nextPoint, from: window), in: scroll))
                XCTAssertEqual(nextBefore.content.messageID, nextReaderID)
                fixture.releaseHeldLoads()
                try await Task.sleep(for: .milliseconds(1_500))
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
            let viewModel = try makeScriptedChatViewModel(streamClient: stream) { request in
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
                ChatView(session: SessionSummary(sessionId: "session-abc", title: "Excerpt lifecycle"), server: UITestFixtureEnvironment.serverURL,
                         onAPIError: { _ in }, loadsInitialMessages: false, viewModel: viewModel)
            }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
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
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: prompt.renderID), anchor: .top, using: controller)
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
        let reasoning = try await requireElement(in: window, label: "Select reasoning effort")
        XCTAssertTrue(reasoning.accessibilityTraits.contains(.notEnabled), "Reasoning remains with its owner")
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

    /// TAL-1043: an owner the App cannot reattach keeps the chat read-only with the server's reason.
    func testOwnerChatTheAppCannotReattachSaysWhy() async throws {
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerChatBatchArgument])
        _ = try await requireElement(in: window, label: "Continue this chat in its native CLI.")
        settle(0.3)
        attachHostedScreenshot(window, name: "owner-batch-phone")
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
        let warning = "Memory provider 'honcho' could not be loaded; memory is off."
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

    /// The Agent's notices arrive on the stream, and the one the Agent clears leaves its chip (TAL-831).
    func testANoticeTheServerClearsLeavesItsChip() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers", "--ui-test-session-notices"])
        try await sendFromComposer("Back up the cluster", in: window)
        let warning = "Memory provider 'honcho' could not be loaded; memory is off."
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
        let window = try await hostFixtureChat(["--ui-test-compression-reference"])
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
        let send = await awaitCondition { HostedAccessibility.element(in: sheet.view, label: "Send") != nil }
        XCTAssertTrue(send, "The edit sheet has no Send")
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: sheet.view, label: "Send")))
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

    /// Mounting a buffered target is not arrival; wait before interacting with it.
    private func navigateTranscript(to id: String, anchor: UnitPoint, using controller: ChatScrollPositionController) async throws {
        controller.cancelPreservation()
        let navigate = try XCTUnwrap(controller.onHoldAnchor, "The transcript must register its navigation owner")
        navigate(id, anchor)
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

    func toolResult() async -> ToolResultView {
        toolResultCalls += 1
        await withCheckedContinuation { toolResultContinuation = $0 }
        return ToolResultView(text: "Full retained tool output")
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
                        .environment(\.chatFullToolResultLoader) { _ in await state.toolResult() }
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
final class ApprovalOverlayLayoutTests: XCTestCase {
    func testBookKeepsEveryChoiceOnTheTrailingSide() async throws {
        let fold = CGRect(x: 440, y: 0, width: 20, height: 760)
        let window = try hostApproval(size: CGSize(width: 900, height: 760), divisions: [fold])
        attachHostedScreenshot(window, name: "approval-book")
        for title in ["Allow once", "Allow session", "Always allow", "Deny", "Skip all this session"] {
            let button = try XCTUnwrap(HostedAccessibility.element(in: window, label: title))
            XCTAssertGreaterThanOrEqual(button.accessibilityFrame.minX, fold.maxX + 18,
                "\(title) must stay inside the trailing pane, including its padding")
            XCTAssertFalse(button.accessibilityFrame.intersects(fold), "\(title) crosses the fold")
        }
    }

    func testTabletopKeepsEveryChoiceAboveTheFold() async throws {
        let fold = CGRect(x: 0, y: 470, width: 900, height: 20)
        let window = try hostApproval(size: CGSize(width: 900, height: 960), divisions: [fold])
        attachHostedScreenshot(window, name: "approval-tabletop")
        for title in ["Allow once", "Allow session", "Always allow", "Deny", "Skip all this session"] {
            let button = try XCTUnwrap(HostedAccessibility.element(in: window, label: title))
            XCTAssertLessThanOrEqual(button.accessibilityFrame.maxY, fold.minY,
                "\(title) must remain above the fold")
            XCTAssertFalse(button.accessibilityFrame.intersects(fold), "\(title) crosses the fold")
        }
    }

    func testLongDetailsKeepActionsVisibleAboveTheFold() async throws {
        let fold = CGRect(x: 0, y: 370, width: 900, height: 20)
        let window = try hostApproval(size: CGSize(width: 900, height: 760), divisions: [fold],
            description: Array(repeating: "A line of synthetic approval details.", count: 40).joined(separator: "\n"))
        attachHostedScreenshot(window, name: "approval-tabletop-long-details")
        for title in ["Allow once", "Allow session", "Always allow", "Deny", "Skip all this session"] {
            let button = try XCTUnwrap(HostedAccessibility.element(in: window, label: title))
            XCTAssertGreaterThan(button.accessibilityFrame.height, 0)
            XCTAssertGreaterThanOrEqual(button.accessibilityFrame.minY, 0)
            XCTAssertLessThanOrEqual(button.accessibilityFrame.maxY, fold.minY)
        }
    }

    func testFlatPhoneKeepsTheOriginalCenteredCard() throws {
        let window = try hostApproval(size: HostedSize.phone, divisions: [])
        attachHostedScreenshot(window, name: "approval-flat-phone")
        let allow = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Allow once"))
        XCTAssertEqual(allow.accessibilityFrame.minX, 34, accuracy: 1)
    }

    func testCardFramesRespectBookTabletopAndLayoutDirection() {
        let bounds = CGRect(x: 0, y: 0, width: 900, height: 760)
        let book = CGRect(x: 440, y: 0, width: 20, height: 760)
        let size = CGSize(width: 520, height: 300)
        XCTAssertEqual(ApprovalRequestOverlay.cardFrame(in: bounds, divisions: [book], cardSize: size),
                       CGRect(x: 478, y: 230, width: 404, height: 300))
        XCTAssertEqual(ApprovalRequestOverlay.cardFrame(in: bounds, divisions: [book], cardSize: size,
                                                       layoutDirection: .rightToLeft),
                       CGRect(x: 18, y: 230, width: 404, height: 300))
        let tabletop = CGRect(x: 0, y: 370, width: 900, height: 20)
        XCTAssertEqual(ApprovalRequestOverlay.cardFrame(in: bounds, divisions: [tabletop], cardSize: size),
                       CGRect(x: 190, y: 35, width: 520, height: 300))
    }

    func testFlatAndOffscreenDivisionsKeepTheCenteredFrame() {
        let bounds = CGRect(x: 0, y: 0, width: 900, height: 760)
        let size = CGSize(width: 520, height: 300)
        let expected = CGRect(x: 190, y: 230, width: 520, height: 300)
        XCTAssertEqual(ApprovalRequestOverlay.cardFrame(in: bounds, divisions: [], cardSize: size), expected)
        XCTAssertEqual(ApprovalRequestOverlay.cardFrame(in: bounds,
            divisions: [CGRect(x: 1000, y: 0, width: 20, height: 760)], cardSize: size), expected)
        let phone = CGRect(x: 0, y: 0, width: 390, height: 844)
        XCTAssertEqual(ApprovalRequestOverlay.cardFrame(in: phone, divisions: [], cardSize: size),
                       CGRect(x: 18, y: 272, width: 354, height: 300))
    }

    func testOversizedCardIsConstrainedWithinThePane() {
        let bounds = CGRect(x: 30, y: 20, width: 900, height: 760)
        let fold = CGRect(x: 30, y: 390, width: 900, height: 20)
        let frame = ApprovalRequestOverlay.cardFrame(in: bounds, divisions: [fold],
                                                     cardSize: CGSize(width: 2000, height: 2000))
        XCTAssertEqual(frame, CGRect(x: 220, y: 20, width: 520, height: 370))
        XCTAssertFalse(frame.intersects(fold))
    }

    private func hostApproval(size: CGSize, divisions: [CGRect],
                              description: String = "Run the fixture command?") throws -> UIWindow {
        let pending = PendingApproval(approvalId: "synthetic-fold-approval", command: "echo fixture",
                                      description: description)
        return try hostWindow(ApprovalRequestOverlay(
            prompt: ApprovalPromptState(sessionID: "synthetic-fold-session", pending: pending, pendingCount: 1),
            isResponding: false, errorMessage: nil, onChoice: { _ in }, onSkipAll: {},
            divisionFrames: divisions
        ).ignoresSafeArea(), size: size)
    }
}
