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
