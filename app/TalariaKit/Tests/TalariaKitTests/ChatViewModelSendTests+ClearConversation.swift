import SwiftData
import XCTest
@testable import TalariaKit

// TAL-848: `/clear` clears the session on the server, applies at once, and rolls back or reconciles on failure.
private let clearServerURL = URL(string: "https://example.test")!
private let unclearedSessionJSON = """
{"session":{"session_id":"session-abc","title":"Old title","messages":[\
{"role":"user","content":"Old question","timestamp":1,"message_id":"old-user"},\
{"role":"assistant","content":"Old answer","timestamp":2,"message_id":"old-answer"}]}}
"""
private let clearedSessionJSON = """
{"session":{"session_id":"session-abc","title":"Untitled","messages":[\
{"role":"assistant","content":"Session finalized.","timestamp":3,"message_id":"finalize-notice"}]}}
"""
private let clearedRowJSON = #"{"ok":true,"session":{"session_id":"session-abc","title":"Untitled","message_count":1}}"#

private final class ClearServer: @unchecked Sendable {
    private let lock = NSLock()
    private var cleared = false
    private(set) var clearBodies: [[String: Any]] = []
    var clearAnswer: (URLRequest) throws -> (HTTPURLResponse, Data) = { apiTestJSONResponse(clearedRowJSON, for: $0) }
    var clearsOnRequest = true

    var clearCount: Int { lock.withLock { clearBodies.count } }

    func handle(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
        switch request.url?.path {
        case "/api/session":
            let json = lock.withLock { cleared } ? clearedSessionJSON : unclearedSessionJSON
            return apiTestJSONResponse(json, for: request)
        case "/api/session/clear":
            let body = try apiTestJSONBody(from: request)
            lock.withLock {
                clearBodies.append(body)
                if clearsOnRequest { cleared = true }
            }
            return try clearAnswer(request)
        case "/api/chat/start":
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-clear"}"#, for: request)
        default:
            XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
    }
}

@MainActor
extension ChatViewModelSendTests {
    private func clearCommand() throws -> SlashCommand {
        try XCTUnwrap(SlashCommandCatalog.command(named: "clear"))
    }

    private func loadedClearFixture(_ server: ClearServer, context: ModelContext? = nil) async throws -> ChatViewModel {
        let model = try makeViewModel(streamClient: SpySSEStreamingClient(), handler: server.handle)
        await model.loadMessages(modelContext: try context ?? makeContext())
        XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"])
        return model
    }

    func testClearSlashCommandClearsTheServerSessionAfterConfirmation() async throws {
        let server = ClearServer()
        let context = try makeContext()
        let model = try await loadedClearFixture(server, context: context)

        let result = await model.executeSlashCommand(try clearCommand())
        await model.confirmClearConversation()

        XCTAssertEqual(server.clearCount, 1, "/clear must send one POST /api/session/clear")
        XCTAssertEqual(server.clearBodies.first?["session_id"] as? String, "session-abc")
        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertEqual(model.messages.compactMap(\.content), ["Session finalized."])
        XCTAssertEqual(model.displayTitle, "Untitled")
        XCTAssertNil(model.sendErrorMessage)

        ChatViewModel.resetActiveStreamSnapshotsForTesting()
        let reopened = try makeViewModel { _ in throw URLError(.notConnectedToInternet) }
        reopened.prepareInitialMessageLoad(modelContext: context)
        XCTAssertFalse(reopened.messages.contains { ["Old question", "Old answer"].contains($0.content) },
                       "The offline cache must not bring the cleared messages back")
    }

    func testClearEmptiesTheTranscriptBeforeTheServerAnswers() async throws {
        let server = ClearServer()
        let arrived = expectation(description: "clear request held")
        let release = DispatchSemaphore(value: 0)
        server.clearAnswer = { request in
            arrived.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + .seconds(10)), .success)
            return apiTestJSONResponse(clearedRowJSON, for: request)
        }
        let model = try await loadedClearFixture(server)

        _ = await model.executeSlashCommand(try clearCommand())
        let confirm = Task { await model.confirmClearConversation() }
        defer { release.signal() }
        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertTrue(model.messages.isEmpty, "The transcript must empty before the server answers")
        release.signal()
        await confirm.value
        XCTAssertEqual(model.messages.compactMap(\.content), ["Session finalized."])
    }

    func testCancellingClearSendsNothingAndKeepsTheTranscript() async throws {
        let server = ClearServer()
        let model = try await loadedClearFixture(server)

        let result = await model.executeSlashCommand(try clearCommand())
        XCTAssertEqual(result, .executed(message: nil))
        XCTAssertTrue(model.isConfirmingClear)
        XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"], "Asking must not clear yet")
        model.cancelClearConversation()

        XCTAssertFalse(model.isConfirmingClear)
        XCTAssertEqual(server.clearCount, 0)
        XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"])
    }

    func testRefusedClearRestoresTheTranscriptWithTheServerError() async throws {
        for status in [400, 403] {
            let server = ClearServer()
            server.clearsOnRequest = false
            server.clearAnswer = { request in
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error":"Synthetic view-only session"}"#.utf8))
            }
            let model = try await loadedClearFixture(server)

            _ = await model.executeSlashCommand(try clearCommand())
            await model.confirmClearConversation()

            XCTAssertEqual(server.clearCount, 1, "\(status)")
            XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"], "\(status)")
            XCTAssertEqual(model.sendErrorMessage?.hasSuffix(": Synthetic view-only session"), true, "\(status)")
        }
    }

    func testUnknownClearOutcomeReconcilesWithTheServerWithoutResending() async throws {
        let failures: [(String, (URLRequest) throws -> (HTTPURLResponse, Data))] = [
            ("network", { _ in throw URLError(.networkConnectionLost) }),
            ("5xx", { request in
                (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, Data(#"{"error":"Synthetic outage"}"#.utf8))
            }),
        ]
        for (name, failure) in failures {
            for serverCleared in [true, false] {
                let label = "\(name), server cleared: \(serverCleared)"
                let server = ClearServer()
                server.clearsOnRequest = serverCleared
                server.clearAnswer = failure
                let model = try await loadedClearFixture(server)

                _ = await model.executeSlashCommand(try clearCommand())
                await model.confirmClearConversation()

                XCTAssertEqual(server.clearCount, 1, "The clear must never be replayed: \(label)")
                if serverCleared {
                    XCTAssertEqual(model.messages.compactMap(\.content), ["Session finalized."], label)
                    XCTAssertNil(model.sendErrorMessage, label)
                } else {
                    XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"], label)
                    XCTAssertNotNil(model.sendErrorMessage, label)
                }
            }
        }
    }

    func testClearIsRefusedDuringAReplyAndWhileOffline() async throws {
        let server = ClearServer()
        let model = try await loadedClearFixture(server)
        let didStart = await model.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        let transcript = model.messages

        let streaming = await model.executeSlashCommand(try clearCommand())
        await model.confirmClearConversation()

        XCTAssertEqual(streaming, .unsupported(friendlyMessage: "Stop the reply before clearing."))
        XCTAssertFalse(model.isConfirmingClear)
        XCTAssertEqual(model.messages, transcript)

        let context = try makeContext()
        try CacheStore.cacheMessages(
            [ChatMessage(role: "user", content: "Cached question", timestamp: 1, messageId: "cached-user")],
            serverURL: clearServerURL, sessionID: "session-abc", in: context
        )
        let offline = try makeViewModel { _ in throw URLError(.notConnectedToInternet) }
        await offline.loadMessages(modelContext: context)
        XCTAssertTrue(offline.isViewingCachedData)

        let cached = await offline.executeSlashCommand(try clearCommand())
        await offline.confirmClearConversation()

        XCTAssertEqual(cached, .unsupported(friendlyMessage: "Reconnect to the server to clear this conversation."))
        XCTAssertEqual(offline.messages.compactMap(\.content), ["Cached question"])
        XCTAssertEqual(server.clearCount, 0)
    }
}
