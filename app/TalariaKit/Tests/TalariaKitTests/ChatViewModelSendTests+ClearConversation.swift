import SwiftData
import XCTest
@testable import TalariaKit

// TAL-848: `/clear` clears the session on the server, applies at once, and rolls back or reconciles on failure.
private let clearServerURL = URL(string: "https://example.test")!
private let unclearedSessionJSON = """
{"session":{"session_id":"session-abc","title":"Old title","clear_generation":"generation-before","messages":[\
{"role":"user","content":"Old question","timestamp":1,"message_id":"old-user"},\
{"role":"assistant","content":"Old answer","timestamp":2,"message_id":"old-answer"}]}}
"""
private let clearedSessionJSON = """
{"session":{"session_id":"session-abc","title":"Untitled","clear_generation":"generation-after","messages":[\
{"role":"assistant","content":"Session finalized.","timestamp":3,"message_id":"finalize-notice"}]}}
"""
private let clearedRowJSON = #"{"ok":true,"session":{"session_id":"session-abc","title":"Untitled","message_count":1}}"#

private final class ClearServer: @unchecked Sendable {
    private let lock = NSLock()
    private var cleared = false
    private(set) var clearBodies: [[String: Any]] = []
    var clearAnswer: (URLRequest) throws -> (HTTPURLResponse, Data) = { apiTestJSONResponse(clearedRowJSON, for: $0) }
    var clearsOnRequest = true
    /// An older server sends no `clear_generation`.
    var reportsClearGeneration = true
    /// Holds the next `GET /api/session` until the test releases it, answering with the transcript it saw on arrival.
    var heldRead: (arrived: XCTestExpectation, release: DispatchSemaphore)?
    private var recordedPaths: [String] = []
    var paths: [String] { lock.withLock { recordedPaths } }

    var clearCount: Int { lock.withLock { clearBodies.count } }

    func handle(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
        lock.withLock { recordedPaths.append(request.url?.path ?? "") }
        switch request.url?.path {
        case "/api/session":
            var json = lock.withLock { cleared } ? clearedSessionJSON : unclearedSessionJSON
            if !reportsClearGeneration {
                json = json.replacingOccurrences(of: #""clear_generation":"generation-before","#, with: "")
                    .replacingOccurrences(of: #""clear_generation":"generation-after","#, with: "")
            }
            if let held = lock.withLock({ () -> (arrived: XCTestExpectation, release: DispatchSemaphore)? in
                defer { heldRead = nil }
                return heldRead
            }) {
                held.arrived.fulfill()
                XCTAssertEqual(held.release.wait(timeout: .now() + .seconds(10)), .success)
            }
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
                    XCTAssertEqual(model.displayTitle, "Untitled", label)
                    XCTAssertNil(model.sendErrorMessage, label)
                } else {
                    XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"], label)
                    XCTAssertNotNil(model.sendErrorMessage, label)
                }
            }
        }
    }

    func testUnknownClearOutcomeOnAnOlderServerRestoresTheTranscript() async throws {
        let server = ClearServer()
        server.reportsClearGeneration = false
        server.clearAnswer = { _ in throw URLError(.timedOut) }
        let model = try await loadedClearFixture(server)

        _ = await model.executeSlashCommand(try clearCommand())
        await model.confirmClearConversation()

        XCTAssertEqual(server.clearCount, 1)
        XCTAssertEqual(model.messages.compactMap(\.content), ["Old question", "Old answer"],
                       "Without the server's clear marker the outcome stays unconfirmed")
        XCTAssertNotNil(model.sendErrorMessage)
    }

    func testAMessageSentDuringAClearIsShownAtOnceAndSentAfterIt() async throws {
        // Deferred answers let the clear stay outstanding without blocking later requests from starting.
        let host = "clear-send.test"
        let server = ClearServer()
        let started = DeferredRequests()
        let heldClear = DeferredRequests()
        func answer(_ request: DeferredMockURLProtocol) {
            do {
                let (response, data) = try server.handle(request.request)
                request.complete(withJSON: String(decoding: data, as: UTF8.self), statusCode: response.statusCode)
            } catch {
                request.fail(with: error)
            }
        }
        DeferredMockURLProtocol.setOnRequest({ request in
            _ = started.append(request)
            if request.request.url?.path == "/api/session/clear" { _ = heldClear.append(request) } else { answer(request) }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let model = try makeViewModel(
            server: try XCTUnwrap(URL(string: "https://\(host)")), protocolClasses: [DeferredMockURLProtocol.self],
            handler: { _ in throw URLError(.badURL) }
        )
        await model.loadMessages(modelContext: try makeContext())
        func startedPaths() -> [String] { (0..<started.count).map { started.request(at: $0).request.url?.path ?? "" } }

        _ = await model.executeSlashCommand(try clearCommand())
        let confirm = Task { await model.confirmClearConversation() }
        try await waitUntil { heldClear.count == 1 }
        let send = Task { await model.sendMessage("After the clear") }
        try await waitUntil { model.messages.contains { $0.content == "After the clear" } }
        // Give a send that ignored the clear time to start its request.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(startedPaths().contains("/api/chat/start"), "The send must wait for the outstanding clear")
        answer(heldClear.request(at: 0))
        let didStart = await send.value
        await confirm.value

        XCTAssertTrue(didStart)
        let paths = startedPaths()
        XCTAssertLessThan(try XCTUnwrap(paths.firstIndex(of: "/api/session/clear")), try XCTUnwrap(paths.firstIndex(of: "/api/chat/start")))
        XCTAssertTrue(model.messages.contains { $0.content == "After the clear" })
        XCTAssertFalse(model.messages.contains { ["Old question", "Old answer"].contains($0.content) })
    }

    func testAReadInFlightWhenClearingCannotBringTheOldMessagesBack() async throws {
        let server = ClearServer()
        let context = try makeContext()
        let model = try await loadedClearFixture(server, context: context)
        let readArrived = expectation(description: "stale read held")
        let releaseRead = DispatchSemaphore(value: 0)
        server.heldRead = (readArrived, releaseRead)
        let clearArrived = expectation(description: "clear request held")
        let releaseClear = DispatchSemaphore(value: 0)
        server.clearAnswer = { request in
            clearArrived.fulfill()
            XCTAssertEqual(releaseClear.wait(timeout: .now() + .seconds(10)), .success)
            return apiTestJSONResponse(clearedRowJSON, for: request)
        }
        let staleRead = Task { await model.loadMessages(modelContext: context) }
        defer { releaseRead.signal(); releaseClear.signal() }
        await fulfillment(of: [readArrived], timeout: 5)

        _ = await model.executeSlashCommand(try clearCommand())
        let confirm = Task { await model.confirmClearConversation() }
        try await waitUntil { model.messages.isEmpty }
        releaseRead.signal()
        await staleRead.value
        XCTAssertTrue(model.messages.isEmpty, "A read issued before the clear must not repaint the cleared rows")
        await fulfillment(of: [clearArrived], timeout: 5)
        releaseClear.signal()
        await confirm.value

        XCTAssertEqual(model.messages.compactMap(\.content), ["Session finalized."])
        XCTAssertFalse(try CacheStore.cachedMessages(serverURL: clearServerURL, sessionID: "session-abc", in: context)
            .contains { ["Old question", "Old answer"].contains($0.content) })
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
