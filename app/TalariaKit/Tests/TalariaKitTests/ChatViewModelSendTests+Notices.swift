import XCTest
@testable import TalariaKit

// TAL-1001: one short notice above the composer, gone on its own or on tap, never saved.
@MainActor
extension ChatViewModelSendTests {
    private func noticeViewModel() throws -> ChatViewModel {
        try makeViewModel { request in
            XCTFail("Unexpected request \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
    }

    func testANewNoticeReplacesTheShownOneAndTheSameNoticeKeepsItsIdentity() throws {
        let viewModel = try noticeViewModel()
        viewModel.noticeClock = ManualTestClock()

        viewModel.showNotice("  Goal set.  ")
        let first = try XCTUnwrap(viewModel.currentNotice)
        XCTAssertEqual(first.text, "Goal set.")
        XCTAssertEqual(first.level, .info)

        viewModel.showNotice("Goal set.")
        XCTAssertEqual(viewModel.currentNotice?.id, first.id, "The same notice again re-presented itself")

        viewModel.showNotice("The Agent already took this message.", level: .warn)
        XCTAssertNotEqual(viewModel.currentNotice?.id, first.id)
        XCTAssertEqual(viewModel.currentNotice?.level, .warn)

        viewModel.showNotice("   ")
        XCTAssertEqual(viewModel.currentNotice?.level, .warn, "A blank notice replaced the shown one")
        XCTAssertTrue(viewModel.messages.isEmpty, "A notice became a transcript row")
    }

    func testANoticeGoesAfterItsLevelsLifetimeAndTheSameNoticeRestartsIt() async throws {
        let viewModel = try noticeViewModel()
        let clock = ManualTestClock()
        viewModel.noticeClock = clock

        // Shown again before it went, its 2.5 s start over: the first deadline passes without ending it.
        viewModel.showNotice("Goal set.")
        await clock.advance(by: .seconds(2))
        viewModel.showNotice("Goal set.")
        await clock.advance(by: .seconds(2))
        XCTAssertEqual(viewModel.currentNotice?.text, "Goal set.", "The repeat did not restart the notice's time")
        await clock.advance(by: .milliseconds(500))
        try await waitUntil { viewModel.currentNotice == nil }

        // A warning stays its own 5 s.
        viewModel.showNotice("Nothing could take it.", level: .warn)
        await clock.advance(by: .milliseconds(4_900))
        XCTAssertEqual(viewModel.currentNotice?.level, .warn, "A warning went on an info notice's time")
        await clock.advance(by: .milliseconds(100))
        try await waitUntil { viewModel.currentNotice == nil }
    }

    func testEachLevelHasItsLifetime() {
        XCTAssertEqual(SessionNotice.Level.info.noticeLifetime, .milliseconds(2500))
        XCTAssertEqual(SessionNotice.Level.success.noticeLifetime, .milliseconds(2500))
        XCTAssertEqual(SessionNotice.Level.warn.noticeLifetime, .seconds(5))
        XCTAssertEqual(SessionNotice.Level.error.noticeLifetime, .seconds(5))
    }

    func testTapAndResetDismissTheNotice() throws {
        let viewModel = try noticeViewModel()
        viewModel.noticeClock = ManualTestClock()

        viewModel.showNotice("Goal set.")
        viewModel.dismissNotice()
        XCTAssertNil(viewModel.currentNotice)

        viewModel.showNotice("Goal set.")
        viewModel.clearTranscript()
        XCTAssertNil(viewModel.currentNotice)
    }
}
