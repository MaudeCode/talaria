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
        viewModel.noticeLifetime = { _ in .seconds(60) }

        viewModel.showNotice("  Goal set.  ")
        let first = try XCTUnwrap(viewModel.currentNotice)
        XCTAssertEqual(first.text, "Goal set.")
        XCTAssertEqual(first.kind, .info)

        viewModel.showNotice("Goal set.")
        XCTAssertEqual(viewModel.currentNotice?.id, first.id, "The same notice again re-presented itself")

        viewModel.showNotice("This steering message can no longer be changed.", kind: .warning)
        XCTAssertNotEqual(viewModel.currentNotice?.id, first.id)
        XCTAssertEqual(viewModel.currentNotice?.kind, .warning)

        viewModel.showNotice("   ")
        XCTAssertEqual(viewModel.currentNotice?.kind, .warning, "A blank notice replaced the shown one")
        XCTAssertTrue(viewModel.messages.isEmpty, "A notice became a transcript row")
    }

    func testANoticeGoesAfterItsKindsLifetimeAndTheSameNoticeRestartsIt() async throws {
        let viewModel = try noticeViewModel()
        var lifetimes: [Duration] = [.milliseconds(50), .seconds(60), .milliseconds(50)]
        var askedKinds: [ChatNoticeKind] = []
        viewModel.noticeLifetime = { kind in
            askedKinds.append(kind)
            return lifetimes.removeFirst()
        }

        // Shown again before it went, its time starts over: the first 50 ms never ends it.
        viewModel.showNotice("Goal set.")
        viewModel.showNotice("Goal set.")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(viewModel.currentNotice?.text, "Goal set.", "The repeat did not restart the notice's time")

        viewModel.showNotice("Nothing could take it.", kind: .warning)
        let deadline = ContinuousClock.now + .seconds(5)
        while viewModel.currentNotice != nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNil(viewModel.currentNotice, "The notice never went on its own")
        XCTAssertEqual(askedKinds, [.info, .info, .warning])
    }

    func testEachKindHasItsLifetime() {
        XCTAssertEqual(ChatNoticeKind.info.lifetime, .milliseconds(2500))
        XCTAssertEqual(ChatNoticeKind.warning.lifetime, .seconds(5))
        XCTAssertEqual(ChatNoticeKind.error.lifetime, .seconds(5))
    }

    func testTapAndResetDismissTheNotice() throws {
        let viewModel = try noticeViewModel()
        viewModel.noticeLifetime = { _ in .seconds(60) }

        viewModel.showNotice("Goal set.")
        viewModel.dismissNotice()
        XCTAssertNil(viewModel.currentNotice)

        viewModel.showNotice("Goal set.")
        viewModel.clearTranscript()
        XCTAssertNil(viewModel.currentNotice)
    }
}
