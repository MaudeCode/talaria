import XCTest
import SwiftData
import SwiftUI
import UIKit
@testable import Talaria
@testable import TalariaKit

final class ChatViewModelSendTests: XCTestCase {
    override func tearDown() {
        ChatViewModel.resetActiveStreamSnapshotsForTesting()
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }
}

// Asserts the English plural wording from the App's string catalog, which only the App bundle carries.
extension ChatViewModelSendTests {
    @MainActor
    func testReloadedToolProgressDisappearsWhenStreamEnds() async throws {
        for (size, name) in [(CGSize(width: 320, height: 844), "phone"), (HostedSize.padLandscape, "pad")] {
            let fixture = try FixtureApp(for: self)
            let stream = SpySSEStreamingClient()
            let model = try makeReloadedToolProgressModel(stream: stream)
            defer {
                model.suspendStreamForNavigation()
                model.cleanupPollingTasks()
                stream.stop()
            }
            await model.loadMessages()
            await model.reconnectStreamIfNeeded()
            await model.loadComposerConfiguration()
            XCTAssertNil(model.lastError, "The progress fixture must start without an API error")
            let window = try hostWindow(NavigationStack {
                ChatView(session: SessionSummary(sessionId: "session-abc", title: "Reloaded tool progress"),
                    server: URL(string: "https://example.test")!, onAPIError: { _ in },
                    loadsInitialMessages: false, viewModel: model)
            }.modelContainer(fixture.cache), size: size)
            let hasProgress = { (element: NSObject) in element.accessibilityLabel?.contains("42% · indexing") == true }
            _ = try await requireElement(in: window, where: hasProgress)
            attachHostedScreenshot(window, name: "reloaded-progress-before-end-\(name)")
            stream.emit(.streamEnd)
            let cleared = await awaitNoElement(in: window, where: hasProgress)
            attachHostedScreenshot(window, name: "reloaded-progress-after-end-\(name)")
            XCTAssertTrue(cleared, "\(name) kept persisted tool progress after stream_end")
            _ = try await requireElement(in: window, where: { $0.accessibilityLabel?.contains("Calling a tool") == true })
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    @MainActor
    func testCompletedStreamSessionKeepsActivityFromMessageToolCalls() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("Check the workspace")
        XCTAssertTrue(didStart)
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: "tool.started",
            name: "terminal",
            preview: "pwd",
            args: ["command": .string("pwd")],
            duration: nil,
            isError: nil
        )))

        let completedSession = try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {
              "role": "user",
              "content": "Check the workspace",
              "message_id": "user-1"
            },
            {
              "role": "assistant",
              "content": "",
              "message_id": "assistant-tool",
              "tool_calls": [
                {
                  "id": "call-1",
                  "function": {
                    "name": "terminal",
                    "arguments": "{\\"command\\":\\"pwd\\"}"
                  },
                  "done": true,
                  "is_error": false,
                  "duration": 0.3,
                  "result": "/Users/tester/project"
                }
              ]
            },
            {
              "role": "tool",
              "content": "/Users/tester/project",
              "message_id": "tool-1",
              "tool_call_id": "call-1"
            },
            {
              "role": "assistant",
              "content": "The workspace is /Users/tester/project.",
              "message_id": "assistant-final"
            }
          ]
        }
        """)

        streamClient.emit(.done(DoneStreamEvent(session: completedSession)))

        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertTrue(viewModel.liveToolCalls.isEmpty)
        XCTAssertEqual(viewModel.completedToolCallGroups.count, 1)
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.anchorMessageID, "assistant-tool")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.activityTitle, "Activity: 1 tool")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.name, "terminal")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.preview, "/Users/tester/project")
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.args?["command"], .string("pwd"))
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.duration, 0.3)
        XCTAssertEqual(viewModel.completedToolCallGroups.first?.toolCalls.first?.isError, false)
        XCTAssertEqual(
            viewModel.completedToolCallGroupsForAnchor("assistant-tool"),
            viewModel.completedToolCallGroups
        )
        XCTAssertTrue(viewModel.completedToolCallGroupsForAnchor(nil).isEmpty)
    }
}

// Asserts AVAudioSession categories, which exist only on iOS.
extension ChatViewModelSendTests {
    func testListenAudioSessionRoutesToSpeakerNotEarpiece() {
        // `.playback` forces the speaker (not the receiver/earpiece) by default, and
        // `.spokenAudio` is Apple's recommended mode for synthesized speech. #252.
        XCTAssertEqual(ListenAudioSessionConfiguration.category, .playback)
        XCTAssertEqual(ListenAudioSessionConfiguration.mode, .spokenAudio)
        XCTAssertTrue(
            ListenAudioSessionConfiguration.deactivationOptions.contains(.notifyOthersOnDeactivation)
        )
    }
}

// TAL-906: Listen speaks the server's read-aloud script on both engines; the App strips nothing itself.
extension ChatViewModelSendTests {
    @MainActor
    func testListenSpeaksTheServerSpokenTextOnServerAndOnDeviceEngines() async throws {
        // app/TalariaTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let exchange = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/speech-prepare.json"))) as? [String: [String: String]])
        let message = try XCTUnwrap(exchange["request"]?["text"])
        let spoken = try XCTUnwrap(exchange["response"]?["spoken_text"])
        let speechSynthesizer = SpySpeechSynthesizer()
        var paths: [String] = []
        let viewModel = try makeViewModel(speechSynthesizerFactory: { speechSynthesizer }, spokenText: nil) { request in
            paths.append(request.url?.path ?? "")
            let text = try apiTestJSONBody(from: request)["text"] as? String
            switch request.url?.path {
            case "/api/speech/prepare":
                XCTAssertEqual(text, message)
                return apiTestJSONResponse(String(decoding: try JSONSerialization.data(withJSONObject: exchange["response"] ?? [:]), as: UTF8.self), for: request)
            default:
                XCTAssertEqual(text, spoken)
                return Self.ttsUnavailableResponse(for: request)
            }
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(role: "assistant", content: message, timestamp: 1_770_000_090, messageId: "assistant-90"),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(paths, ["/api/speech/prepare", "/api/tts"])
        XCTAssertEqual(speechSynthesizer.spokenStrings, [spoken])
    }
}

@MainActor
extension ChatViewModelSendTests {
    func testOrdinarySyncPillKeepsItsMinimumVisibleHold() async throws {
        let (viewModel, _, window, requests) = try await makeHeldSyncChat(host: "ordinary-sync-hold.test")
        let reload = Task { await viewModel.loadMessages() }
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        requests.request(at: 1).complete(withJSON: Self.hostedSyncTranscript)
        await reload.value
        XCTAssertFalse(viewModel.isSyncingTranscript)
        settle(0.05)
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"),
                        "Ordinary completion must honor the minimum-visible hold instead of flashing the sync pill.")
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(cleared)
    }

    func testFastFailedSendDoesNotRestoreHeldSyncPresentation() async throws {
        let (viewModel, _, window, requests) = try await makeHeldSyncChat(host: "fast-send-sync-hold.test")
        let reload = Task { await viewModel.loadMessages() }
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        let send = Task { await viewModel.sendMessage("Failed question") }
        let started = await awaitCondition { requests.count == 3 }
        XCTAssertTrue(started)
        requests.request(at: 2).complete(withJSON: #"{"error":"Send failed"}"#, statusCode: 500)
        let sent = await send.value
        XCTAssertFalse(sent)
        requests.request(at: 1).complete(withJSON: Self.hostedSyncTranscript)
        await reload.value
        settle(0.05)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"),
                     "A fast failed send must cancel the previous sync hold, not reveal it again.")
    }

    func testSendProgressNeverShowsSyncingDuringAHeldReload() async throws {
        let (viewModel, stream, window, requests) = try await makeHeldSyncChat(host: "hosted-send-sync.test")
        let reload = Task { await viewModel.loadMessages() }
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        attachHostedScreenshot(window, name: "send-status-before-submission")
        let send = Task { await viewModel.sendMessage("Next question") }
        let sendStarted = await awaitCondition { requests.count == 3 }
        XCTAssertTrue(sendStarted)
        _ = try await requireElement(in: window, label: "Hermes is starting a response")
        requests.request(at: 2).complete(withJSON: #"{"session_id":"session-abc","stream_id":"stream-123"}"#)
        let sent = await send.value
        XCTAssertTrue(sent)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Hermes is working on the response") == true }
        settle(0.5)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        attachHostedScreenshot(window, name: "send-status-response-with-held-reload")
        stream.emit(.token("Live answer"))
        _ = try await requireElement(in: window, label: "Live answer")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        requests.request(at: 1).complete(withJSON: Self.hostedSyncTranscript)
        await reload.value
    }

    private static let hostedSyncTranscript = #"{"session":{"session_id":"session-abc","messages":[{"role":"user","content":"Earlier question","message_id":"earlier-user"},{"role":"assistant","content":"Earlier answer","message_id":"earlier-answer"}]}}"#

    private func makeHeldSyncChat(host: String) async throws -> (ChatViewModel, SpySSEStreamingClient, UIWindow, DeferredRequests) {
        let fixture = try FixtureApp(for: self)
        let requests = DeferredRequests()
        DeferredMockURLProtocol.setOnRequest({ request in
            if ["/api/session", "/api/chat/start"].contains(request.request.url?.path ?? "") {
                _ = requests.append(request)
            } else {
                request.complete(withJSON: "{}")
            }
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let stream = SpySSEStreamingClient()
        let summary = SessionSummary(sessionId: "session-abc", title: "Send status")
        let viewModel = try makeViewModel(streamClient: stream, sessionSummary: summary,
            server: URL(string: "https://\(host)")!, protocolClasses: [DeferredMockURLProtocol.self]) { _ in
            throw URLError(.badURL)
        }
        addTeardownBlock {
            await MainActor.run { viewModel.suspendStreamForNavigation(); viewModel.cleanupPollingTasks() }
        }
        let initial = Task { await viewModel.loadMessages() }
        let initialStarted = await awaitCondition { requests.count == 1 }
        XCTAssertTrue(initialStarted)
        requests.request(at: 0).complete(withJSON: Self.hostedSyncTranscript)
        await initial.value
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://\(host)")!, onAPIError: { _ in },
                     loadsInitialMessages: false, viewModel: viewModel)
        }.modelContainer(fixture.cache))
        return (viewModel, stream, window, requests)
    }
}
