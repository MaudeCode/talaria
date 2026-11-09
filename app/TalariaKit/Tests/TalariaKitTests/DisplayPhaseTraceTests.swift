import XCTest
@testable import TalariaKit

/// TAL-1412: every display-phase interval ends exactly once, only by its own operation, and with metadata that carries
/// no session content.
@MainActor
final class DisplayPhaseTraceTests: XCTestCase {
    private let recorder = RecordingSignposter()

    func testIntervalsEndOnceAfterTheFrameLaysOut() async {
        let launch = DisplayPhaseOperation(.launch, signposter: recorder)
        XCTAssertEqual(recorder.open, ["Launch", "Launch Ready"])

        launch.markVisible(.cache, rows: 3)
        XCTAssertEqual(recorder.open, ["Launch", "Launch Ready"], "An end waits for the frame's layout.")
        await nextMainQueueTurn()
        launch.markVisible(.server, rows: 5)
        launch.markReady(.server, rows: 5)
        launch.markReady(.failed, rows: 0)
        launch.cancel(.cancelled)
        await nextMainQueueTurn()

        XCTAssertEqual(recorder.ended, [
            "Launch outcome=cache rows=3",
            "Launch Ready outcome=server rows=5",
        ])
        XCTAssertTrue(recorder.open.isEmpty)
    }

    func testReadyBeforeAnyVisibleFrameEndsBothAndCancelEndsTheRest() async {
        let open = DisplayPhaseOperation(.sessionOpen, signposter: recorder)
        open.markReady(.server, rows: 0)
        let older = DisplayPhaseOperation(.loadEarlier, signposter: recorder)
        let onboarding = DisplayPhaseOperation(.launch, signposter: recorder)
        onboarding.cancel(.onboarding)
        older.cancel(.cancelled)
        await nextMainQueueTurn()

        XCTAssertEqual(recorder.ended, [
            "Launch outcome=onboarding rows=0",
            "Launch Ready outcome=onboarding rows=0",
            "Load Earlier outcome=cancelled rows=0",
            "Session Open outcome=server rows=0",
            "Session Open Ready outcome=server rows=0",
        ])
        XCTAssertTrue(recorder.open.isEmpty)
    }

    func testOnlyTheResolvedSessionOfTheSceneEndsItsOpen() async {
        let scene = SessionOpenTrace(signposter: recorder)
        let otherWindow = SessionOpenTrace(signposter: recorder)
        let first = scene.begin()
        scene.resolve(first, to: "first-session")
        let replacing = scene.begin()
        let window = otherWindow.begin()
        otherWindow.resolve(window, to: "second-session")

        // The replaced open's chat, an unresolved open and the other window's chat cannot close this scene's open.
        scene.markReady(sessionID: "first-session", .server, rows: 4)
        scene.markReady(sessionID: "second-session", .server, rows: 4)
        scene.resolve(replacing, to: "second-session")
        scene.resolve(first, to: "first-session")
        scene.markVisible(sessionID: "second-session", .cache, rows: 2)
        scene.markReady(sessionID: "second-session", .server, rows: 6)
        await nextMainQueueTurn()

        XCTAssertEqual(recorder.ended, [
            "Session Open outcome=replaced rows=0",
            "Session Open Ready outcome=replaced rows=0",
            "Session Open outcome=cache rows=2",
            "Session Open Ready outcome=server rows=6",
        ])
        XCTAssertEqual(recorder.open.count, 2, "The other window's open stays its own.")
        otherWindow.markReady(sessionID: "second-session", .server, rows: 1)
        await nextMainQueueTurn()
        XCTAssertTrue(recorder.open.isEmpty)
    }

    func testAFailedOpenEndsAsNotReachedAndNoLaterChatEndsIt() async {
        let scene = SessionOpenTrace(signposter: recorder)
        let failed = scene.begin()
        scene.resolve(failed, to: nil)
        scene.markReady(sessionID: "any-session", .server, rows: 1)
        await nextMainQueueTurn()

        XCTAssertEqual(recorder.ended, [
            "Session Open outcome=cancelled rows=0",
            "Session Open Ready outcome=cancelled rows=0",
        ])
    }

    func testMetadataCarriesOnlyAnOutcomeAndACount() async {
        let scene = SessionOpenTrace(signposter: recorder)
        let sessionID = "private-session-id /Users/someone/secret"
        scene.resolve(scene.begin(), to: sessionID)
        scene.markVisible(sessionID: sessionID, .cache, rows: 2)
        scene.markReady(sessionID: sessionID, .server, rows: 3)
        await nextMainQueueTurn()

        XCTAssertEqual(recorder.metadata.count, 2)
        for metadata in recorder.metadata {
            XCTAssertNotNil(metadata.wholeMatch(of: /outcome=[a-z]+ rows=\d+/), metadata)
            XCTAssertFalse(metadata.contains("private"), metadata)
        }
    }

    private func nextMainQueueTurn() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}

@MainActor
private final class RecordingSignposter: DisplayPhaseSignposting {
    private var names: [Int: String] = [:]
    private var nextHandle = 0
    private(set) var ended: [String] = []
    private(set) var metadata: [String] = []

    var open: [String] { names.keys.sorted().compactMap { names[$0] } }

    func begin(_ name: StaticString) -> Int {
        nextHandle += 1
        names[nextHandle] = "\(name)"
        return nextHandle
    }

    func end(_ name: StaticString, _ handle: Int, metadata: String) {
        XCTAssertEqual(names.removeValue(forKey: handle), "\(name)", "Ended an interval that was not open.")
        ended.append("\(name) \(metadata)")
        self.metadata.append(metadata)
    }
}
