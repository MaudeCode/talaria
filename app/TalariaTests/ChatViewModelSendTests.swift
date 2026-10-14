import XCTest
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
