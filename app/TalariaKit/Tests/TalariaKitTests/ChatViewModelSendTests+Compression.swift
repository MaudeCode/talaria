import XCTest
@testable import TalariaKit

/// TAL-1006: a manual /compress runs the server's joinable job and shows its start in the run status chip.
@MainActor
extension ChatViewModelSendTests {
    private final class CompressionLog: @unchecked Sendable {
        var statusReads = 0
        var shownStart: Date?
    }

    func testManualCompressionTimesTheChipFromTheJobAndStopsWatchingAJobThatNeverEnds() async throws {
        let log = CompressionLog()
        var viewModel: ChatViewModel?
        var intervals = ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 1_000_000_000)
        intervals.sleep = { _ in log.shownStart = viewModel?.compressionStartedAt }
        viewModel = try makeViewModel(sessionSummary: try makeSession(), pollingIntervals: intervals) { request in
            switch request.url?.path ?? "" {
            case "/api/session/compress/start", "/api/session/compress/status":
                if request.url?.path == "/api/session/compress/status" { log.statusReads += 1 }
                return apiTestJSONResponse(#"{"ok":true,"status":"running","session_id":"session-abc","started_at":1800000000}"#, for: request)
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
        let model = try XCTUnwrap(viewModel)

        let result = await model.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "compress")))

        XCTAssertEqual(log.shownStart, Date(timeIntervalSince1970: 1_800_000_000), "The chip did not count from the server's start")
        XCTAssertEqual(log.statusReads, ChatViewModel.compressionPollLimit)
        XCTAssertEqual(result, .unsupported(friendlyMessage: "Compression is still running. Run /compress again to check on it."))
        XCTAssertFalse(model.isCompressingSession, "The composer stayed locked")
        XCTAssertNil(model.compressionStartedAt)
    }

    func testComingBackToARunningManualJobShowsItsChipAndFollowsItToTheEnd() async throws {
        // TAL-1006: the session names the job another view started; this one shows it and polls it, never starting another.
        final class RejoinLog: @unchecked Sendable {
            var statusReads = 0
            var starts = 0
            var shownStart: Date?
        }
        let log = RejoinLog()
        var viewModel: ChatViewModel?
        var intervals = ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 1_000_000_000)
        intervals.sleep = { _ in log.shownStart = viewModel?.compressionStartedAt }
        viewModel = try makeViewModel(sessionSummary: try makeSession(), pollingIntervals: intervals) { request in
            switch request.url?.path ?? "" {
            case "/api/session":
                let running = log.statusReads < 2 ? #", "compression_started_at": 1800000000"# : ""
                return apiTestJSONResponse(#"{"session": {"session_id": "session-abc", "messages": []\#(running)}}"#, for: request)
            case "/api/session/compress/status":
                log.statusReads += 1
                let body = log.statusReads < 2
                    ? #"{"ok": true, "status": "running", "session_id": "session-abc", "started_at": 1800000000}"#
                    : #"{"ok": true, "status": "done", "session_id": "session-abc", "session": {"session_id": "session-abc", "messages": []}}"#
                return apiTestJSONResponse(body, for: request)
            case "/api/session/compress/start":
                log.starts += 1
                return apiTestJSONResponse(#"{"ok": true, "status": "running"}"#, for: request)
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
        let model = try XCTUnwrap(viewModel)

        await model.loadMessages()
        try await waitUntil { log.statusReads >= 2 && !model.isCompressingSession }

        XCTAssertEqual(log.shownStart, Date(timeIntervalSince1970: 1_800_000_000), "The chip did not show the job's server start")
        XCTAssertEqual(log.starts, 0, "Coming back started another compression")
        XCTAssertNil(model.compressionStartedAt)
    }
}
