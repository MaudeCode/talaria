import SwiftUI
import XCTest
@testable import TalariaKit

final class SessionsChangeTriggerTests: XCTestCase {
    private func changed(_ reason: String?, _ sessionID: String? = nil) -> SessionsChange {
        .changed(reason: reason, sessionID: sessionID)
    }

    func testEveryTriggerResyncsAfterAReconnect() {
        for trigger in [SessionsChangeTrigger.anyChange, .runEnded, .cronRun, .session("chat-1")] {
            XCTAssertTrue(trigger.matches(.resync), "\(trigger)")
        }
    }

    func testListScreensRefreshOnAnyChange() {
        XCTAssertTrue(SessionsChangeTrigger.anyChange.matches(changed("session_rename", "chat-2")))
        XCTAssertTrue(SessionsChangeTrigger.anyChange.matches(changed("attention_pending")))
    }

    func testRunEndedMatchesOnlyFinishedRuns() {
        for reason in ["session_done", "session_error", "session_cancel", "cron_complete"] {
            XCTAssertTrue(SessionsChangeTrigger.runEnded.matches(changed(reason, "chat-2")), reason)
        }
        for reason in ["turn_started", "session_rename", "title", "attention_pending"] {
            XCTAssertFalse(SessionsChangeTrigger.runEnded.matches(changed(reason, "chat-2")), reason)
        }
    }

    func testCronRunMatchesOnlyCronCompletion() {
        XCTAssertTrue(SessionsChangeTrigger.cronRun.matches(changed("cron_complete")))
        XCTAssertFalse(SessionsChangeTrigger.cronRun.matches(changed("session_done", "chat-2")))
    }

    func testAChatSyncsForItsOwnSessionAndForCoalescedTranscriptChangesOnly() {
        let trigger = SessionsChangeTrigger.session("chat-1")
        XCTAssertTrue(trigger.matches(changed("turn_started", "chat-1")))
        XCTAssertTrue(trigger.matches(changed("session_done", "chat-1")))
        XCTAssertFalse(trigger.matches(changed("turn_started", "chat-2")), "Another chat's run")
        // A burst for different chats drops the session id; it may still be this chat's run.
        XCTAssertTrue(trigger.matches(changed("session_done", nil)))
        // Changes that never touch a transcript are skipped even without an id.
        for reason in ["attention_pending", "attention_resolved", "project_create", "session_pin", "cron_complete"] {
            XCTAssertFalse(trigger.matches(changed(reason, nil)), reason)
        }
    }
}

final class ForegroundReturnDetectorTests: XCTestCase {
    func testOnlyTheFirstActiveAfterTheBackgroundCountsAsAReturn() {
        var detector = ForegroundReturnDetector()
        XCTAssertFalse(detector.didReturnToForeground(on: .active), "Launch is not a return")
        XCTAssertFalse(detector.didReturnToForeground(on: .inactive), "Control Center")
        XCTAssertFalse(detector.didReturnToForeground(on: .active), "Back from Control Center")
        XCTAssertFalse(detector.didReturnToForeground(on: .inactive))
        XCTAssertFalse(detector.didReturnToForeground(on: .background))
        XCTAssertFalse(detector.didReturnToForeground(on: .inactive))
        XCTAssertTrue(detector.didReturnToForeground(on: .active), "Back from the background")
        XCTAssertFalse(detector.didReturnToForeground(on: .active), "Counted once")
    }
}

final class SessionEventFrameDecoderTests: XCTestCase {
    func testDecodesASessionsChangedFrame() {
        let frame = SessionEventFrameDecoder.decode(
            eventType: "sessions_changed",
            data: #"{"type":"sessions_changed","version":3,"reason":"turn_started","session_id":"chat-1","stream":"sessions","extra":1}"#
        )
        XCTAssertEqual(frame, .changed(.changed(reason: "turn_started", sessionID: "chat-1")))
    }

    func testACoalescedFrameWithoutASessionStillCounts() {
        let frame = SessionEventFrameDecoder.decode(eventType: "sessions_changed", data: #"{"reason":"session_done"}"#)
        XCTAssertEqual(frame, .changed(.changed(reason: "session_done", sessionID: nil)))
    }

    func testOtherEventsAndMalformedDataAreIgnored() {
        XCTAssertEqual(SessionEventFrameDecoder.decode(eventType: "gateway_status", data: "{}"), .ignored)
        XCTAssertEqual(SessionEventFrameDecoder.decode(eventType: "sessions_changed", data: "not json"), .ignored)
    }
}

@MainActor
final class SessionEventsMonitorTests: XCTestCase {
    private let url = URL(string: "https://example.test/api/sessions/events")!

    func testReconnectsWithBackoffAndResyncsOnlyAfterAReconnect() async {
        let client = ScriptedSessionEventClient(attempts: [
            [.frame(.opened), .frame(.changed(.changed(reason: "turn_started", sessionID: "chat-1"))), .fail],
            [.fail],
            [.fail],
            [.frame(.opened), .fail]
        ])
        var changes: [SessionsChange] = []
        var delays: [Duration] = []

        await SessionEventsMonitor.run(
            url: url,
            client: client,
            onChange: { changes.append($0) },
            sleep: { delay in
                delays.append(delay)
                if delays.count == 4 { throw CancellationError() }
            }
        )

        XCTAssertEqual(changes, [.changed(reason: "turn_started", sessionID: "chat-1"), .resync])
        XCTAssertEqual(delays, [.seconds(1), .seconds(2), .seconds(4), .seconds(1)], "A connection that opened resets the backoff")
        XCTAssertEqual(client.startedURLs, Array(repeating: url, count: 4))
    }

    func testRepeatedFailuresSettleOnTheSteadyRetryDelay() async {
        let client = ScriptedSessionEventClient(attempts: Array(repeating: [.fail], count: 5))
        var delays: [Duration] = []

        await SessionEventsMonitor.run(
            url: url,
            client: client,
            onChange: { _ in },
            sleep: { delay in
                delays.append(delay)
                if delays.count == 5 { throw CancellationError() }
            }
        )

        XCTAssertEqual(delays, [.seconds(1), .seconds(2), .seconds(4), .seconds(30), .seconds(30)])
    }

    func testCancellingTheTaskClosesTheStream() async {
        let client = ScriptedSessionEventClient(attempts: [[.frame(.opened)]])
        let task = Task { @MainActor in
            await SessionEventsMonitor.run(url: url, client: client, onChange: { _ in })
        }
        for _ in 0..<1_000 where client.startedURLs.isEmpty { await Task.yield() }
        XCTAssertEqual(client.startedURLs, [url])

        task.cancel()
        await task.value

        XCTAssertGreaterThanOrEqual(client.stopCount, 1)
    }
}

final class SessionListRowsDestinationTests: XCTestCase {
    func testScheduledAndWebhookListsShowTheSessionListRows() {
        XCTAssertTrue(SessionNavigationDestination.utility(.scheduled).showsSessionListRows)
        XCTAssertTrue(SessionNavigationDestination.utility(.webhook).showsSessionListRows)
        XCTAssertFalse(SessionNavigationDestination.utility(.archived).showsSessionListRows)
        XCTAssertFalse(SessionNavigationDestination.utility(.tasks).showsSessionListRows)
    }
}

/// Replays one scripted list of callbacks per connection attempt, synchronously from `start`.
@MainActor
private final class ScriptedSessionEventClient: SessionEventStreaming {
    enum Step { case frame(SessionEventFrame), fail }

    private var attempts: [[Step]]
    private(set) var startedURLs: [URL] = []
    private(set) var stopCount = 0

    init(attempts: [[Step]]) {
        self.attempts = attempts
    }

    func start(
        url: URL,
        onFrame: @escaping @MainActor (SessionEventFrame) -> Void,
        onFailure: @escaping @MainActor () -> Void
    ) {
        startedURLs.append(url)
        let steps = attempts.isEmpty ? [] : attempts.removeFirst()
        for step in steps {
            switch step {
            case .frame(let frame): onFrame(frame)
            case .fail: onFailure()
            }
        }
    }

    func stop() {
        stopCount += 1
    }
}
