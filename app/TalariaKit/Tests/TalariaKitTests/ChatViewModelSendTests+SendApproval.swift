import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testAcceptedDenyClearsPromptWithoutReportingServerRejection() async throws {
        let stream = SpySSEStreamingClient()
        let approvals = SpySSEStreamingClient()
        var submittedChoice: String?
        let viewModel = try makeViewModel(streamClient: stream, approvalStreamClient: approvals,
            clarifyStreamClient: SpySSEStreamingClient()) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/approval/respond":
                submittedChoice = try XCTUnwrap(apiTestJSONBody(from: request))["choice"] as? String
                return apiTestJSONResponse(#"{"ok":true,"choice":"deny"}"#, for: request)
            case "/api/approval/pending":
                return apiTestJSONResponse(#"{"pending":null,"pending_count":0}"#, for: request)
            default:
                throw URLError(.badURL)
            }
        }
        let started = await viewModel.sendMessage("Synthetic approval")
        XCTAssertTrue(started)
        approvals.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(approvalId: "synthetic-deny", command: "synthetic-command"), pendingCount: 1
        )))
        XCTAssertNotNil(viewModel.approvalPrompt)
        let denied = await viewModel.respondToApproval(.deny)
        XCTAssertTrue(denied)
        XCTAssertEqual(submittedChoice, "deny")
        XCTAssertNil(viewModel.approvalPrompt)
        XCTAssertNil(viewModel.approvalErrorMessage)
    }

    func testDisableApprovalBypassFailurePreservesTheServerFlagAndReportsError() async throws {
        for response in [#"{"yolo_enabled":true}"#, #"{}"#] {
            let viewModel = try makeViewModel { request in
                let body = request.httpMethod == "POST" ? response : #"{"yolo_enabled":true}"#
                return apiTestJSONResponse(body, for: request)
            }
            await viewModel.refreshApprovalBypassState()
            let disabled = await viewModel.disableApprovalBypassForCurrentSession()
            XCTAssertFalse(disabled)
            XCTAssertTrue(viewModel.isSessionApprovalBypassEnabled)
            XCTAssertNotNil(viewModel.sendErrorMessage)
        }
    }

    func testDisableApprovalBypassRequiresServerConfirmedFalse() async throws {
        var submitted = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session/yolo")
            if request.httpMethod == "POST" {
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["enabled"] as? Bool, false)
                submitted += 1
                return apiTestJSONResponse(#"{"ok":true,"yolo_enabled":false}"#, for: request)
            }
            return apiTestJSONResponse(#"{"yolo_enabled":true}"#, for: request)
        }
        await viewModel.refreshApprovalBypassState()
        XCTAssertTrue(viewModel.isSessionApprovalBypassEnabled)
        let disabled = await viewModel.disableApprovalBypassForCurrentSession()
        XCTAssertTrue(disabled)
        XCTAssertEqual(submitted, 1)
        XCTAssertFalse(viewModel.isSessionApprovalBypassEnabled)
    }


    func testSelectWorkspaceUpdatesSelectionAndRollsBackOnFailure() async throws {
        var updateCount = 0
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session/update")
            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(body["session_id"] as? String, "session-abc")
            XCTAssertEqual(body["model"] as? String, "gpt-5.4")

            updateCount += 1
            if updateCount == 1 {
                XCTAssertEqual(body["workspace"] as? String, "/tmp/next")
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "workspace": "/tmp/next",
                    "model": "gpt-5.4"
                  }
                }
                """, for: request)
            }

            XCTAssertEqual(body["workspace"] as? String, "/tmp/failing")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 500,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            return (try XCTUnwrap(response), Data(#"{"error":"workspace failed"}"#.utf8))
        }

        XCTAssertEqual(viewModel.selectedWorkspacePath, "/tmp/workspace")

        await viewModel.selectWorkspacePath("/tmp/next")
        XCTAssertEqual(viewModel.selectedWorkspacePath, "/tmp/next")
        XCTAssertNil(viewModel.composerConfigurationErrorMessage)

        await viewModel.selectWorkspacePath("/tmp/failing")
        XCTAssertEqual(viewModel.selectedWorkspacePath, "/tmp/next")
        XCTAssertNotNil(viewModel.composerConfigurationErrorMessage)
        XCTAssertEqual(updateCount, 2)
    }

    @MainActor
    func testSendMessageRollsBackOptimisticMessageWhenStartReturnsNoStreamID() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "photo.png",
                  "path": "/tmp/workspace/photo.png",
                  "size": 4,
                  "mime": "image/png",
                  "is_image": true
                }
                """, for: request)
            case "/api/chat/start":
                let data = try XCTUnwrap(apiTestBodyData(from: request))
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                XCTAssertEqual(body["message"] as? String, "Summarize it\n\n[Attached files: /tmp/workspace/photo.png]")
                XCTAssertNotNil(body["attachments"])

                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "error": "Could not start chat"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(
            data: Data([0x00, 0x01, 0x02, 0x03]),
            filename: "photo.png",
            previewData: Data([0x99])
        )

        XCTAssertEqual(viewModel.pendingAttachments.count, 1)

        let didStart = await viewModel.sendMessage("Summarize it")

        XCTAssertFalse(didStart)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertTrue(viewModel.localAttachmentPreviews.isEmpty)
        XCTAssertEqual(viewModel.pendingAttachments.count, 1)
        XCTAssertEqual(viewModel.pendingAttachments.first?.name, "photo.png")
        XCTAssertEqual(viewModel.sendErrorMessage, "Could not start chat")
    }

    @MainActor
    func testSendMessageAddsSingleOptimisticUserMessageWhenStartSucceeds() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")

            let body = try XCTUnwrap(apiTestJSONBody(from: request))
            XCTAssertEqual(body["message"] as? String, "Keep working")

            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await viewModel.sendMessage("  Keep working  ")

        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.role, "user")
        XCTAssertEqual(viewModel.messages.first?.content, "Keep working")
        XCTAssertEqual(viewModel.messages.filter { $0.role == "user" && $0.content == "Keep working" }.count, 1)
    }

    @MainActor
    func testSendVoiceNoteSendsBareTranscriptWithoutAttachedFilesSuffix() async throws {
        let streamClient = SpySSEStreamingClient()
        let transcript = "Hello, hello, testing. Can you hear me?"
        var startMessage: String?
        var startAttachments: [[String: Any]]?
        var requestedPaths: [String] = []

        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")
            switch path {
            case "/api/transcribe":
                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "transcript": "\(transcript)"
                }
                """, for: request)
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "voice-note.m4a",
                  "path": "/tmp/workspace/voice-note.m4a",
                  "size": 2048,
                  "mime": "audio/m4a",
                  "is_image": false
                }
                """, for: request)
            case "/api/chat/start":
                let body = try apiTestJSONBody(from: request)
                startMessage = body["message"] as? String
                startAttachments = body["attachments"] as? [[String: Any]]
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendVoiceNote(
            audioData: Data("fake-m4a-bytes".utf8),
            filename: "voice-note.m4a"
        )

        XCTAssertTrue(didStart)
        XCTAssertEqual(requestedPaths, ["/api/transcribe", "/api/upload", "/api/chat/start"])

        // The message the model sees is exactly the transcript — no
        // "[Attached files: …]" suffix that would make the agent try to "inspect"
        // (transcribe) the clip itself instead of answering the transcript (#330).
        XCTAssertEqual(startMessage, transcript)
        XCTAssertFalse(try XCTUnwrap(startMessage).contains("[Attached files:"))

        // The clip still rides along as a display-only attachment so the inline
        // player renders and persists; the server strips this attachment metadata
        // before the model call, so it never reaches the agent.
        let attachments = try XCTUnwrap(startAttachments)
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(attachments.first?["path"] as? String, "/tmp/workspace/voice-note.m4a")
        XCTAssertEqual(attachments.first?["mime"] as? String, "audio/m4a")
        XCTAssertEqual(attachments.first?["is_image"] as? Bool, false)

        // Optimistic bubble: transcript text plus the playable clip attachment.
        let optimistic = try XCTUnwrap(viewModel.messages.first)
        XCTAssertEqual(optimistic.role, "user")
        XCTAssertEqual(optimistic.content, transcript)
        XCTAssertEqual(optimistic.attachments?.count, 1)
        XCTAssertEqual(optimistic.attachments?.first?.mime, "audio/m4a")
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    func testChatMessageTextStillAppendsAttachedFilesSuffixForFileUploads() {
        // Guard: the voice-note path deliberately bypasses chatMessageText to send
        // the bare transcript (#330), but real file uploads from the text composer
        // MUST keep the "[Attached files: …]" suffix so the agent can inspect them.
        let file = PendingAttachment(
            name: "report.pdf",
            path: "/tmp/workspace/report.pdf",
            mime: "application/pdf",
            size: 1234,
            isImage: false,
            thumbnailData: nil
        )

        let text = PendingAttachment.chatMessageText(draft: "Summarize this", attachments: [file])

        XCTAssertEqual(text, "Summarize this\n\n[Attached files: /tmp/workspace/report.pdf]")
    }

    @MainActor
    func testSubmitGoalAttachesToServerStartedKickoffStream() async throws {
        let streamClient = SpySSEStreamingClient()
        let liveActivityManager = SpyChatLiveActivityManager()
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager
        ) { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/goal":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["args"] as? String, "Ship the TestFlight build")
                XCTAssertEqual(body["workspace"] as? String, "/tmp/workspace")
                XCTAssertEqual(body["model"] as? String, "gpt-5.4")

                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "action": "set",
                  "message": "Goal set.",
                  "goal": {
                    "goal": "Ship the TestFlight build",
                    "status": "active",
                    "turns_used": 0,
                    "max_turns": 20
                  },
                  "kickoff_prompt": "Start executing the goal."
                }
                """, for: request)
            case "/api/session":
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Planning",
                    "active_stream_id": "stream-goal",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Start executing the goal.",
                        "timestamp": 1770000100,
                        "message_id": "user-goal"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didSubmit = await viewModel.submitGoal(args: "Ship the TestFlight build")

        XCTAssertTrue(didSubmit)
        XCTAssertEqual(requestedPaths, ["/api/goal", "/api/session"])
        XCTAssertEqual(viewModel.currentGoal?.goal, "Ship the TestFlight build")
        XCTAssertEqual(viewModel.currentGoal?.status, "active")
        XCTAssertTrue(viewModel.hasActivatedGoalCommand)
        XCTAssertEqual(viewModel.activeStreamID, "stream-goal")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.startedURLs.first?.path, "/api/chat/stream")
        XCTAssertEqual(liveActivityManager.aggregateArms.count, 1)
        XCTAssertEqual(liveActivityManager.aggregateArms.first?.sessionID, "session-abc")
        XCTAssertEqual(liveActivityManager.aggregateArms.first?.sessionTitle, "Planning")
        XCTAssertEqual(viewModel.messages.map(\.role), ["user"])
        XCTAssertEqual(viewModel.messages.last?.content, "Start executing the goal.")
        XCTAssertEqual(viewModel.pinnedLocalNotices, ["Goal set."])

        streamClient.emit(.token("Working now."))

        XCTAssertEqual(viewModel.messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(viewModel.messages.last?.content, "Working now.")
    }

    @MainActor
    func testGoalSlashCommandSubmitsStatusAndRevealsGoalControls() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/goal")

            let body = try XCTUnwrap(apiTestJSONBody(from: request))
            XCTAssertEqual(body["session_id"] as? String, "session-abc")
            XCTAssertEqual(body["args"] as? String, "status")
            XCTAssertEqual(body["workspace"] as? String, "/tmp/workspace")
            XCTAssertEqual(body["model"] as? String, "gpt-5.4")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "action": "status",
              "message": "Goal is active.",
              "goal": {
                "goal": "Ship the TestFlight build",
                "status": "active",
                "turns_used": 1,
                "max_turns": 20
              }
            }
            """, for: request)
        }

        XCTAssertFalse(viewModel.hasActivatedGoalCommand)

        let result = await SlashCommandExecutor.execute(text: "/goal", viewModel: viewModel)

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertTrue(viewModel.hasActivatedGoalCommand)
        XCTAssertEqual(viewModel.currentGoal?.goal, "Ship the TestFlight build")
        XCTAssertEqual(viewModel.currentGoal?.status, "active")
        XCTAssertEqual(viewModel.messages.map(\.role), ["local_notice"])
        XCTAssertEqual(viewModel.messages.first?.content, "Goal is active.")
    }

    @MainActor
    func testBareResumeSlashCommandFallsThroughToNormalSendPath() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/skills":
                return apiTestJSONResponse(#"{"skills": []}"#, for: request)
            case "/api/chat/start":
                XCTFail("Executor fallthrough should let ChatView perform the normal send later.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await SlashCommandExecutor.execute(text: "/resume", viewModel: viewModel)

        XCTAssertEqual(result, .sendAsMessage)
        XCTAssertEqual(requestedPaths, ["/api/skills"])
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testUnknownNonBlockedSlashCommandFallsThroughToNormalSendPath() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/skills":
                return apiTestJSONResponse(#"{"skills": []}"#, for: request)
            case "/api/chat/start":
                XCTFail("Executor fallthrough should let ChatView perform the normal send later.")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await SlashCommandExecutor.execute(text: "/unknown-slash keep going", viewModel: viewModel)

        XCTAssertEqual(result, .sendAsMessage)
        XCTAssertEqual(requestedPaths, ["/api/skills"])
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testServerUnsupportedSlashCommandStaysBlockedWithoutSkillLookup() async throws {
        // TAL-314: the cached server catalog lists `/terminal` for Web only, with the message iOS shows.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let cache = ResponseCache(server: try XCTUnwrap(URL(string: "https://example.test")), root: root)
        cache.entry(ResponseCache.Kind.commands).save(Data(#"""
        {"commands": [{"name": "terminal", "aliases": [], "handler": "client", "clients": ["web"], "unsupported_message": "Terminal stays on the web."}]}
        """#.utf8))
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel(responseCache: cache) { request in
            requestedPaths.append(request.url?.path ?? "nil")
            XCTFail("Unsupported commands should not request skills or start chat.")
            throw URLError(.badURL)
        }
        viewModel.showCachedComposerChoices()

        let result = await SlashCommandExecutor.execute(text: "/terminal", viewModel: viewModel)

        XCTAssertEqual(result, .unsupported(friendlyMessage: "Terminal stays on the web."))
        XCTAssertEqual(requestedPaths, [])
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testSkillShortcutExecutesBeforeUnknownCommandFallthrough() async throws {
        var startedMessage: String?
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/skills":
                return apiTestJSONResponse("""
                {
                  "skills": [
                    {
                      "name": "Spotify",
                      "category": "media",
                      "description": "Control Spotify playback."
                    }
                  ]
                }
                """, for: request)
            case "/api/chat/start":
                let data = try XCTUnwrap(apiTestBodyData(from: request))
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                startedMessage = body["message"] as? String
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await SlashCommandExecutor.execute(text: "/spotify check songs", viewModel: viewModel)

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(startedMessage, "/spotify check songs")
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testGoalResumeSlashCommandStillUsesGoalEndpoint() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")

            switch path {
            case "/api/goal":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                XCTAssertEqual(body["session_id"] as? String, "session-abc")
                XCTAssertEqual(body["args"] as? String, "resume")
                XCTAssertEqual(body["workspace"] as? String, "/tmp/workspace")
                XCTAssertEqual(body["model"] as? String, "gpt-5.4")

                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "action": "resume",
                  "message": "Goal resumed.",
                  "goal": {
                    "goal": "Ship the TestFlight build",
                    "status": "active",
                    "turns_used": 2,
                    "max_turns": 20
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let result = await SlashCommandExecutor.execute(text: "/goal resume", viewModel: viewModel)

        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(requestedPaths, ["/api/goal"])
        XCTAssertTrue(viewModel.hasActivatedGoalCommand)
        XCTAssertEqual(viewModel.currentGoal?.status, "active")
        XCTAssertEqual(viewModel.messages.map(\.role), ["local_notice"])
        XCTAssertEqual(viewModel.messages.first?.content, "Goal resumed.")
    }

    @MainActor
    func testApprovalStreamPublishesPromptAndRespondsWithoutStoppingChatStream() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        var respondBody: [String: Any]?
        var didFetchPendingAfterResponse = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/approval/respond":
                respondBody = try XCTUnwrap(apiTestJSONBody(from: request))
                return apiTestJSONResponse(#"{"ok": true, "choice": "once"}"#, for: request)
            case "/api/approval/pending":
                didFetchPendingAfterResponse = true
                return apiTestJSONResponse(#"{"pending": null, "pending_count": 0}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")

        XCTAssertTrue(didStart)
        XCTAssertEqual(streamClient.startedURLs.first?.path, "/api/chat/stream")
        XCTAssertEqual(approvalStreamClient.startedURLs.first?.path, "/api/approval/stream")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(approvalStreamClient.startedURLs.first), resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "session_id" })?
                .value,
            "session-abc"
        )

        let gatewayApproval = ApprovalPendingResponse.streamPayload(from: Data("""
        {
          "pending": {
            "id": "approval-1",
            "command": "curl https://example.test/install.sh | bash",
            "description": "High risk command",
            "pattern_keys": ["network_download", "pipe_to_shell"]
          },
          "pending_count": 2
        }
        """.utf8))
        approvalStreamClient.emit(.approvalPending(gatewayApproval))

        XCTAssertEqual(viewModel.approvalPrompt?.sessionID, "session-abc")
        XCTAssertEqual(viewModel.approvalPrompt?.pending.approvalId, "approval-1")
        XCTAssertEqual(viewModel.approvalPrompt?.pendingCount, 2)
        XCTAssertEqual(viewModel.approvalPrompt?.patternKeys, ["network_download", "pipe_to_shell"])

        await viewModel.respondToApproval(.once)

        XCTAssertEqual(respondBody?["session_id"] as? String, "session-abc")
        XCTAssertEqual(respondBody?["choice"] as? String, "once")
        XCTAssertEqual(respondBody?["approval_id"] as? String, "approval-1")
        XCTAssertTrue(didFetchPendingAfterResponse)
        XCTAssertNil(viewModel.approvalPrompt)
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    @MainActor
    func testApprovalResponseDoesNotUseSyntheticDisplayIDWhenServerIdentifierMissing() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        var respondBody: [String: Any]?
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/respond":
                respondBody = try XCTUnwrap(apiTestJSONBody(from: request))
                return apiTestJSONResponse(#"{"ok": true, "choice": "once"}"#, for: request)
            case "/api/approval/pending":
                return apiTestJSONResponse(#"{"pending": null, "pending_count": 0}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                command: "make install",
                description: "Install command",
                patternKey: "install"
            ),
            pendingCount: 1
        )))

        XCTAssertEqual(viewModel.approvalPrompt?.pending.id, "make install-Install command-install")

        await viewModel.respondToApproval(.once)

        XCTAssertEqual(respondBody?["session_id"] as? String, "session-abc")
        XCTAssertEqual(respondBody?["choice"] as? String, "once")
        XCTAssertNil(respondBody?["approval_id"])
    }

    @MainActor
    func testApprovalResponseFailureKeepsPromptAndPublishesActionError() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        let clarifyStreamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/respond":
                throw URLError(.timedOut)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                approvalId: "approval-1",
                command: "make install",
                description: "Install command",
                patternKey: "install"
            ),
            pendingCount: 1
        )))

        let didRespond = await viewModel.respondToApproval(.deny)

        XCTAssertFalse(didRespond)
        XCTAssertEqual(viewModel.approvalPrompt?.pending.approvalId, "approval-1")
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertEqual(viewModel.approvalErrorMessage, viewModel.sendErrorMessage)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    @MainActor
    func testApprovalStale409DismissesPromptWithFriendlyExpiredMessage() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        let clarifyStreamClient = SpySSEStreamingClient()
        var didRefreshPendingAfterStale = false
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/respond":
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 409,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (response, Data(#"{"ok": false, "error": "Approval prompt expired or not found.", "stale": true}"#.utf8))
            case "/api/approval/pending":
                didRefreshPendingAfterStale = true
                return apiTestJSONResponse(#"{"pending": null}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                approvalId: "approval-1",
                command: "make install",
                description: "Install command",
                patternKey: "install"
            ),
            pendingCount: 1
        )))

        let didRespond = await viewModel.respondToApproval(.once)

        // Expired prompt: the stale card dismisses with a friendly explanation
        // instead of sticking around behind a generic failure (issue #25).
        XCTAssertFalse(didRespond)
        XCTAssertNil(viewModel.approvalPrompt)
        XCTAssertNil(viewModel.approvalErrorMessage)
        XCTAssertEqual(
            viewModel.sendErrorMessage,
            PendingPromptExpiredError(prompt: .approval).localizedDescription
        )
        XCTAssertTrue(didRefreshPendingAfterStale)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    /// The protective refusals answer HTTP 200 with `{"ok": false}` — `j()`
    /// defaults to 200 — so only a non-2xx threw and a deliberate refusal read
    /// as success. The card was cleared with no explanation while the agent
    /// stayed blocked, and the next pending refresh made it reappear.
    @MainActor
    func testApprovalRespondRejectedWithOkFalseKeepsTheCardAndExplains() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()

        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: SpySSEStreamingClient()
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/respond":
                // 200, not an error status — that is the whole trap.
                return apiTestJSONResponse(#"{"ok": false, "choice": "once"}"#, for: request)
            case "/api/approval/pending":
                return apiTestJSONResponse("""
                {"pending": {"approval_id": "approval-1", "command": "make install",
                 "description": "Install command", "pattern_key": "install"},
                 "pending_count": 1}
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                approvalId: "approval-1",
                command: "make install",
                description: "Install command",
                patternKey: "install"
            ),
            pendingCount: 1
        )))

        let didRespond = await viewModel.respondToApproval(.once)

        XCTAssertFalse(didRespond, "A refusal is not a success.")
        XCTAssertNotNil(viewModel.approvalPrompt, "The agent is still waiting, so the card stays.")
        XCTAssertNotNil(viewModel.approvalErrorMessage, "Silence here is what made this untraceable.")
    }

    /// A response without `ok: true` is not proof the server accepted the
    /// choice, so the pending card must remain actionable.
    @MainActor
    func testApprovalRespondWithoutAnOkFieldKeepsTheCardAndExplains() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()

        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: SpySSEStreamingClient()
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/respond":
                return apiTestJSONResponse(#"{"choice": "once"}"#, for: request)
            case "/api/approval/pending":
                return apiTestJSONResponse("""
                {"pending": {"approval_id": "approval-1", "command": "make install",
                 "description": "Install command", "pattern_key": "install"},
                 "pending_count": 1}
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                approvalId: "approval-1",
                command: "make install",
                description: "Install command",
                patternKey: "install"
            ),
            pendingCount: 1
        )))

        let didRespond = await viewModel.respondToApproval(.once)

        XCTAssertFalse(didRespond)
        XCTAssertNotNil(viewModel.approvalPrompt)
        XCTAssertNotNil(viewModel.approvalErrorMessage)
    }

    @MainActor
    func testApprovalFallbackPollingFailureStaysDiagnosticOnly() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        let approvalPendingRequests = LockedCounter()
        let pollingIntervals = ChatPollingIntervals(
            approvalNanoseconds: 100_000_000,
            clarificationNanoseconds: 100_000_000,
            backgroundNanoseconds: 100_000_000
        )
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            pollingIntervals: pollingIntervals
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/pending":
                _ = approvalPendingRequests.increment()
                throw URLError(.timedOut)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)

        approvalStreamClient.emit(.transportError("approval stream failed"))
        try await waitUntil {
            approvalPendingRequests.count > 0
        }

        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertNil(viewModel.lastError)
        XCTAssertNil(viewModel.sendErrorMessage)
        XCTAssertNil(viewModel.approvalErrorMessage)

        viewModel.cleanupPollingTasks()
    }

    @MainActor
    func testCleanupPollingTasksCancelsStoredPollingTasks() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        let clarifyStreamClient = SpySSEStreamingClient()
        let approvalPendingRequests = LockedCounter()
        let clarificationPendingRequests = LockedCounter()
        let backgroundStatusRequests = LockedCounter()
        // Each loop polls once and then parks in its interval until cancelled (CI run 36500298117 counted a
        // poll that real 100 ms intervals had already sent when cleanup ran). Distinct intervals name the loops.
        let hold = PollingLoopHold(pollsByInterval: [
            1: approvalPendingRequests,
            2: clarificationPendingRequests,
            3: backgroundStatusRequests
        ])
        let pollingIntervals = ChatPollingIntervals(
            approvalNanoseconds: 1,
            clarificationNanoseconds: 2,
            backgroundNanoseconds: 3,
            sleep: { try await hold.sleep($0) }
        )
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            pollingIntervals: pollingIntervals
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/approval/pending":
                _ = approvalPendingRequests.increment()
                return apiTestJSONResponse(#"{"pending": null, "pending_count": 0}"#, for: request)
            case "/api/clarify/pending":
                _ = clarificationPendingRequests.increment()
                return apiTestJSONResponse(#"{"pending": null, "pending_count": 0}"#, for: request)
            case "/api/background":
                return apiTestJSONResponse(#"{"task_id": "task-1", "stream_id": "stream-bg", "session_id": "background-1"}"#, for: request)
            case "/api/background/tasks":
                _ = backgroundStatusRequests.increment()
                // TAL-372: the started task runs until cleanup, so the card keeps refreshing.
                return apiTestJSONResponse(#"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"task-1","kind":"background_command","status":"running","title":"audit tests","pinned":true,"dismissible":false,"active":true}]}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run the installer")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.transportError("approval stream failed"))
        clarifyStreamClient.emit(.transportError("clarification stream failed"))

        let result = await viewModel.executeSlashCommand(
            try XCTUnwrap(SlashCommandCatalog.command(named: "background")),
            args: "audit tests"
        )
        XCTAssertEqual(result, .executed(message: "Background task started. I'll add the result here when it completes."))

        // Every loop has polled and is parked, so no request is in flight.
        try await waitUntil { hold.parkedLoops == 3 }
        XCTAssertEqual(approvalPendingRequests.count, 1)
        XCTAssertEqual(clarificationPendingRequests.count, 1)
        XCTAssertEqual(backgroundStatusRequests.count, 1)

        viewModel.cleanupPollingTasks()

        // A loop that cleanup left running would stay parked instead of seeing its interval cancelled.
        try await waitUntil { hold.cancelledLoops == 3 }
        await drainMainActor()
        XCTAssertEqual(hold.parkedLoops, 3, "A cancelled loop must not wait for another interval")
        XCTAssertEqual(approvalPendingRequests.count, 1)
        XCTAssertEqual(clarificationPendingRequests.count, 1)
        XCTAssertEqual(backgroundStatusRequests.count, 1)
    }

    @MainActor
    func testApprovalForDifferentSessionDoesNotRenderOverCurrentChat() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
        }

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)

        viewModel.applyApprovalUpdate(
            ApprovalPendingResponse(
                pending: PendingApproval(
                    approvalId: "other-approval",
                    command: "danger",
                    description: "Other session",
                    patternKey: "other"
                ),
                pendingCount: 1
            ),
            sessionID: "other-session"
        )

        XCTAssertNil(viewModel.approvalPrompt)

        viewModel.applyApprovalUpdate(
            ApprovalPendingResponse(
                pending: PendingApproval(
                    approvalId: "current-approval",
                    command: "python script.py",
                    description: "Current session",
                    patternKey: "python_exec"
                ),
                pendingCount: 1
            ),
            sessionID: "session-abc"
        )

        XCTAssertEqual(viewModel.approvalPrompt?.pending.approvalId, "current-approval")
    }

    @MainActor
    func testSkipAllThisSessionEnablesYoloAndClearsPrompt() async throws {
        let streamClient = SpySSEStreamingClient()
        let approvalStreamClient = SpySSEStreamingClient()
        var yoloBody: [String: Any]?
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient
        ) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
            case "/api/session/yolo":
                yoloBody = try XCTUnwrap(apiTestJSONBody(from: request))
                return apiTestJSONResponse(#"{"ok": true, "yolo_enabled": true}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("Run setup")
        XCTAssertTrue(didStart)
        approvalStreamClient.emit(.approvalPending(ApprovalPendingResponse(
            pending: PendingApproval(
                approvalId: "approval-1",
                command: "make install",
                description: "Install command",
                patternKey: "install"
            ),
            pendingCount: 1
        )))
        XCTAssertNotNil(viewModel.approvalPrompt)

        await viewModel.skipApprovalsForCurrentSession()

        XCTAssertEqual(yoloBody?["session_id"] as? String, "session-abc")
        XCTAssertEqual(yoloBody?["enabled"] as? Bool, true)
        XCTAssertEqual(viewModel.isSessionApprovalBypassEnabled, true)
        XCTAssertNil(viewModel.approvalPrompt)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }
    // MARK: - Overlapping sends (TAL-118)

    @MainActor
    func testConcurrentRegularSendsStartOneChatWithOneOptimisticMessage() async throws {
        // Hold `/api/chat/start` open so the second send genuinely overlaps the
        // first instead of depending on request timing.
        let startGate = DispatchSemaphore(value: 0)
        defer { startGate.signal() }
        var startCount = 0
        let streamClient = SpySSEStreamingClient()

        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            startCount += 1
            startGate.wait()

            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let firstSend = Task { @MainActor in await viewModel.sendMessage("First message") }
        try await waitUntil { viewModel.isStartingChat }

        let didStartSecond = await viewModel.sendMessage("Second message")
        XCTAssertFalse(didStartSecond)
        // The rejected caller must not clear the accepted send's busy flag.
        XCTAssertTrue(viewModel.isStartingChat)

        startGate.signal()
        let didStartFirst = await firstSend.value

        XCTAssertTrue(didStartFirst)
        XCTAssertFalse(viewModel.isStartingChat)
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(viewModel.messages.map(\.content), ["First message"])
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testSendMessageDuringVoiceNoteIsRejectedWithoutConsumingAttachments() async throws {
        // Hold transcription open: a regular send attempted mid-voice-note must be
        // rejected before it stages the composer's attachments.
        let transcribeGate = DispatchSemaphore(value: 0)
        defer { transcribeGate.signal() }
        var uploadCount = 0
        var startCount = 0

        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/upload":
                uploadCount += 1
                if uploadCount == 1 {
                    return apiTestJSONResponse("""
                    {
                      "filename": "photo.png",
                      "path": "/tmp/workspace/photo.png",
                      "size": 4,
                      "mime": "image/png",
                      "is_image": true
                    }
                    """, for: request)
                }
                return apiTestJSONResponse("""
                {
                  "filename": "voice-note.m4a",
                  "path": "/tmp/workspace/voice-note.m4a",
                  "size": 2048,
                  "mime": "audio/m4a",
                  "is_image": false
                }
                """, for: request)
            case "/api/transcribe":
                transcribeGate.wait()
                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "transcript": "Hello there"
                }
                """, for: request)
            case "/api/chat/start":
                startCount += 1
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(
            data: Data([0x00, 0x01, 0x02, 0x03]),
            filename: "photo.png",
            previewData: Data([0x99])
        )
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["photo.png"])

        let voiceSend = Task { @MainActor in
            await viewModel.sendVoiceNote(audioData: Data("fake-m4a-bytes".utf8), filename: "voice-note.m4a")
        }
        try await waitUntil { viewModel.isSendingVoiceNote }

        let didStart = await viewModel.sendMessage("Summarize this")

        XCTAssertFalse(didStart)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["photo.png"])
        XCTAssertTrue(viewModel.isSendingVoiceNote)

        transcribeGate.signal()
        let didSendVoice = await voiceSend.value

        XCTAssertTrue(didSendVoice)
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(viewModel.messages.map(\.content), ["Hello there"])
        // The rejected text send never consumed the composer's attachment.
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["photo.png"])
    }

    @MainActor
    func testVoiceNoteDuringRegularStartIsRejectedAndFailedSendRestoresAttachments() async throws {
        let startGate = DispatchSemaphore(value: 0)
        defer { startGate.signal() }
        var requestedPaths: [String] = []

        let viewModel = try makeViewModel { request in
            let path = request.url?.path
            requestedPaths.append(path ?? "nil")
            switch path {
            case "/api/upload":
                return apiTestJSONResponse("""
                {
                  "filename": "photo.png",
                  "path": "/tmp/workspace/photo.png",
                  "size": 4,
                  "mime": "image/png",
                  "is_image": true
                }
                """, for: request)
            case "/api/chat/start":
                startGate.wait()
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "error": "Could not start chat"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.uploadAttachment(
            data: Data([0x00, 0x01, 0x02, 0x03]),
            filename: "photo.png",
            previewData: Data([0x99])
        )
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["photo.png"])

        let textSend = Task { @MainActor in await viewModel.sendMessage("Summarize it") }
        try await waitUntil { viewModel.isStartingChat }

        // The in-flight send owns the attachment, so the composer is empty for now.
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)

        let didSendVoice = await viewModel.sendVoiceNote(
            audioData: Data("fake-m4a-bytes".utf8),
            filename: "voice-note.m4a"
        )

        XCTAssertFalse(didSendVoice)
        XCTAssertFalse(viewModel.isSendingVoiceNote)
        XCTAssertTrue(viewModel.isStartingChat)

        startGate.signal()
        let didStart = await textSend.value

        XCTAssertFalse(didStart)
        XCTAssertFalse(viewModel.isStartingChat)
        // The accepted send failed, so its attachment comes back to the composer
        // and the optimistic row is rolled back.
        XCTAssertEqual(viewModel.pendingAttachments.map(\.name), ["photo.png"])
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertTrue(viewModel.localAttachmentPreviews.isEmpty)
        XCTAssertEqual(viewModel.sendErrorMessage, "Could not start chat")
        // The rejected voice note never reached transcription or upload.
        XCTAssertEqual(requestedPaths, ["/api/upload", "/api/chat/start"])
    }
}

/// Polling-loop sleep that parks a loop in its interval, once it has polled, until the loop is cancelled.
@MainActor
private final class PollingLoopHold {
    private let pollsByInterval: [UInt64: LockedCounter]
    private(set) var parkedLoops = 0
    private(set) var cancelledLoops = 0

    init(pollsByInterval: [UInt64: LockedCounter]) {
        self.pollsByInterval = pollsByInterval
    }

    func sleep(_ interval: UInt64) async throws {
        // The clarification loop skips HTTP until its stream fails; let it check again shortly.
        guard let polls = pollsByInterval[interval], polls.count > 0 else {
            return try await Task.sleep(for: .milliseconds(1))
        }
        parkedLoops += 1
        do {
            try await Task.sleep(for: .seconds(3600))
        } catch {
            cancelledLoops += 1
            throw error
        }
    }
}
