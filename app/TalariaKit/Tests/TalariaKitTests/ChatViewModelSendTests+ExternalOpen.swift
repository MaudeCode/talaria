import XCTest
import SwiftData
@testable import TalariaKit

/// TAL-839: an external row's chat opens at once while the row's detail read verifies it. The chat takes that read
/// as its first transcript request and stays read-only until it answers.
@MainActor
extension ChatViewModelSendTests {
    func testExternalChatTakesItsRowVerificationAndUnlocksWhenTheServerAllowsWriting() async throws {
        let open = try await makeExternalOpen()
        let (chat, trips) = (open.chat, open.trips)

        XCTAssertTrue(chat.isVerifyingSessionAccess)
        XCTAssertTrue(chat.isComposerReadOnly, "Sending must wait for the server's verification")
        XCTAssertFalse(chat.canBranch)
        let sent = await chat.sendMessage("Too soon")
        XCTAssertFalse(sent)
        let prefetch = await trips.nextRoundTrip(timeout: .milliseconds(500))
        XCTAssertEqual(prefetch.map(\.path), [], "The chat must reuse the row's verification read")

        let load = Task { await chat.loadInitialMessages(modelContext: open.context) }
        open.verification.complete(withJSON: Self.externalDetail(readOnly: false))
        let verified = await open.verify.value
        await load.value

        XCTAssertEqual(verified?.isSessionReadOnly, false)
        XCTAssertFalse(chat.isVerifyingSessionAccess)
        XCTAssertFalse(chat.isComposerReadOnly)
        XCTAssertTrue(chat.canBranch)
        XCTAssertEqual(chat.messages.compactMap(\.content), ["From the CLI"])
    }

    func testExternalChatStaysReadOnlyWhenTheServerVerifiesItViewOnly() async throws {
        let open = try await makeExternalOpen(rowReadOnly: false)
        let load = Task { await open.chat.loadInitialMessages(modelContext: open.context) }
        open.verification.complete(withJSON: Self.externalDetail(readOnly: true))
        _ = await open.verify.value
        await load.value

        XCTAssertFalse(open.chat.isVerifyingSessionAccess)
        XCTAssertTrue(open.chat.isComposerReadOnly)
        XCTAssertFalse(open.chat.canBranch)
    }

    func testFailedVerificationShowsInTheChatAndItsRetryUnlocksIt() async throws {
        let open = try await makeExternalOpen()
        let (list, chat, trips) = (open.list, open.chat, open.trips)
        let load = Task { await chat.loadInitialMessages(modelContext: open.context) }
        open.verification.complete(withJSON: #"{"error": "Session not found"}"#, statusCode: 404)
        let verified = await open.verify.value
        await load.value

        XCTAssertNil(verified)
        XCTAssertNil(list.actionErrorMessage, "The opened chat owns the failure")
        XCTAssertEqual(chat.errorMessage, "That session no longer exists on the server. Reopen another session or create a new one.")
        XCTAssertTrue(chat.isVerifyingSessionAccess)
        XCTAssertTrue(chat.isComposerReadOnly)

        let retry = Task { await chat.loadMessages(modelContext: open.context, isUserRefresh: true) }
        let reread = await trips.nextRoundTrip()
        XCTAssertEqual(reread.map(\.path), ["/api/session"])
        reread.forEach { $0.complete(withJSON: Self.externalDetail(readOnly: false)) }
        await retry.value
        XCTAssertNil(chat.errorMessage)
        XCTAssertFalse(chat.isVerifyingSessionAccess)
        XCTAssertFalse(chat.isComposerReadOnly)
    }

    func testLeavingTheExternalChatCancelsItsVerification() async throws {
        let open = try await makeExternalOpen()

        open.chat.suspendStreamForNavigation()

        let verified = await open.verify.value
        XCTAssertNil(verified)
        XCTAssertTrue(open.verification.isStopped, "Back must cancel the shared verification read")
    }

    func testProfileSwitchDuringTheVerificationFencesItsResult() async throws {
        let open = try await makeExternalOpen(prefetches: false)
        for active in ["default", "work"] {
            let profile = Task { await open.list.loadActiveProfile() }
            let profiles = await open.trips.nextRoundTrip()
            XCTAssertEqual(profiles.map(\.path), ["/api/profiles"])
            profiles.forEach { $0.complete(withJSON: #"{"active": "\#(active)", "profiles": [{"name": "default"}, {"name": "work"}]}"#) }
            await profile.value
        }
        XCTAssertNil(open.list.takeOpenVerification(for: "cli-1"), "A chat opened after the switch must read afresh")

        open.verification.complete(withJSON: Self.externalDetail(readOnly: false))
        let verified = await open.verify.value

        XCTAssertNil(verified, "A verification from the previous profile must not refresh or redirect")
    }

    func testWebUIChatOpensUnlockedAndSendsItsOwnRead() async throws {
        let trips = HeldRoundTrips()
        let (host, client) = try heldClient(trips)
        let list = SessionListViewModel(server: try XCTUnwrap(URL(string: "https://\(host)")), client: client)
        let row = SessionSummary(sessionId: "webui-1", isCliSession: true, sessionSource: "webui", sourceKind: .webui)
        let verified = await list.sessionToOpen(for: row)
        XCTAssertEqual(verified, row)

        let chat = try makeHeldChat(host: host, row: row, list: list)
        XCTAssertFalse(chat.isVerifyingSessionAccess)
        XCTAssertFalse(chat.isComposerReadOnly)
        chat.prefetchInitialMessages()
        let prefetch = await trips.nextRoundTrip()
        XCTAssertEqual(prefetch.map(\.path), ["/api/session"], "Only the chat's own read is sent")
        prefetch.forEach { $0.complete(withJSON: #"{"session": {"session_id": "webui-1", "messages": []}}"#) }
    }

    private struct ExternalOpen {
        let list: SessionListViewModel
        let chat: ChatViewModel
        let trips: HeldRoundTrips
        let verification: DeferredMockURLProtocol
        let verify: Task<SessionSummary?, Never>
        let context: ModelContext
    }

    /// Taps an external row and opens its chat while the row's verification read is held.
    private func makeExternalOpen(rowReadOnly: Bool = false, prefetches: Bool = true) async throws -> ExternalOpen {
        let trips = HeldRoundTrips()
        let (host, client) = try heldClient(trips)
        let list = SessionListViewModel(server: try XCTUnwrap(URL(string: "https://\(host)")), client: client)
        let row = SessionSummary(sessionId: "cli-1", title: "CLI chat", isCliSession: true, readOnly: rowReadOnly, canBranch: true)
        let verify = Task { await list.sessionToOpen(for: row) }
        let first = await trips.nextRoundTrip()
        XCTAssertEqual(first.map(\.path), ["/api/session"])
        let context = try makeContext()
        let chat = try makeHeldChat(host: host, row: row, list: list)
        if prefetches {
            chat.prepareInitialMessageLoad(modelContext: context)
            chat.prefetchInitialMessages()
        }
        return ExternalOpen(list: list, chat: chat, trips: trips, verification: try XCTUnwrap(first.first),
                            verify: verify, context: context)
    }

    private func heldClient(_ trips: HeldRoundTrips) throws -> (String, APIClient) {
        let host = "external-open-\(UUID().uuidString.lowercased()).test"
        DeferredMockURLProtocol.setOnRequest(trips.hold, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: try XCTUnwrap(URL(string: "https://\(host)")), session: URLSession(configuration: configuration))
        return (host, client)
    }

    private func makeHeldChat(host: String, row: SessionSummary, list: SessionListViewModel) throws -> ChatViewModel {
        try makeViewModel(sessionSummary: row, server: try XCTUnwrap(URL(string: "https://\(host)")),
                          protocolClasses: [DeferredMockURLProtocol.self], sessionListOwner: list) { _ in
            throw URLError(.badURL)
        }
    }

    private static func externalDetail(readOnly: Bool) -> String {
        """
        {"session": {"session_id": "cli-1", "title": "CLI chat", "is_cli_session": true, "read_only": \(readOnly),
         "can_branch": \(!readOnly), "messages": [{"role": "assistant", "content": "From the CLI", "message_id": "cli"}]}}
        """
    }
}
