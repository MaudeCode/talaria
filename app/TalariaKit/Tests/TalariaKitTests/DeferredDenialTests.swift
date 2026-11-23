import XCTest
@testable import TalariaKit

/// TAL-1488: Deny from a banner or Live Activity waits five seconds for Undo before it is sent.
@MainActor
final class DeferredDenialTests: XCTestCase {
    private let record = DeferredDenial.Record(
        publisherID: "https://approvals.example.test", sessionID: "s1", approvalHeadID: "head-s1", approvalID: nil, fromBanner: false
    )
    private var events: [String] = []
    /// The wall clock a relaunch reads the persisted deadline against.
    private var date = Date(timeIntervalSince1970: 1_800_000_000)

    private func denials(clock: ManualTestClock, defaults: UserDefaults) -> DeferredDenial {
        DeferredDenial(defaults: defaults, clock: clock, now: { [unowned self] in date }, effects: .init(
            show: { [unowned self] in events.append("show \($0.approvalHeadID ?? "")") },
            restore: { [unowned self] in events.append("restore \($0.approvalHeadID ?? "")") },
            send: { [unowned self] in events.append("send \($0.approvalHeadID ?? "")") }
        ))
    }

    private func defaults() -> UserDefaults {
        .ephemeral("DeferredDenialTests")
    }

    func testDenyIsSentWhenTheFiveSecondWindowEnds() async throws {
        let clock = ManualTestClock()
        let denials = denials(clock: clock, defaults: defaults())

        let deny = Task { await denials.deny(record) }
        await clock.advance(by: .milliseconds(4_999))
        XCTAssertEqual(events, ["show head-s1"], "Nothing is sent inside the window")
        await clock.advance(by: .milliseconds(1))
        await deny.value
        XCTAssertEqual(events, ["show head-s1", "send head-s1"])
    }

    func testUndoInsideTheWindowSendsNothingAndRestoresTheWaitingState() async throws {
        let clock = ManualTestClock()
        let store = defaults()
        let denials = denials(clock: clock, defaults: store)

        let deny = Task { await denials.deny(record) }
        await clock.advance(by: .seconds(2))
        // A banner names the server by its URL; the activity by its origin. Both undo the same denial.
        let undone = await denials.undo(publisherID: "https://approvals.example.test/", sessionID: "s1")
        await clock.advance(by: .seconds(5))
        await deny.value

        XCTAssertTrue(undone)
        XCTAssertEqual(events, ["show head-s1", "restore head-s1"])
        await self.denials(clock: ManualTestClock(), defaults: store).resumePersisted()
        XCTAssertEqual(events.count, 2, "An undone denial is never sent on a later launch")
    }

    func testASecondDenyInsideTheWindowReplacesTheFirst() async throws {
        let clock = ManualTestClock()
        let denials = denials(clock: clock, defaults: defaults())
        let next = DeferredDenial.Record(
            publisherID: record.publisherID, sessionID: "s1", approvalHeadID: "head-s1-next", approvalID: nil, fromBanner: true
        )

        let first = Task { await denials.deny(record) }
        await clock.advance(by: .seconds(3))
        let second = Task { await denials.deny(next) }
        await clock.advance(by: .seconds(3))
        await first.value
        XCTAssertEqual(events, ["show head-s1", "show head-s1-next"], "The replaced Deny sends nothing at its own deadline")
        await clock.advance(by: .seconds(2))
        await second.value
        XCTAssertEqual(events, ["show head-s1", "show head-s1-next", "send head-s1-next"])
    }

    /// The process dies inside the window: its timer never fires, and the record stays persisted.
    private func killInsideTheWindow(_ record: DeferredDenial.Record, defaults: UserDefaults) async {
        let killed = denials(clock: ManualTestClock(), defaults: defaults)
        let deny = Task { await killed.deny(record) }
        while events.isEmpty { await Task.yield() }
        deny.cancel()
        await deny.value
        events = []
    }

    func testARelaunchKeepsTheRestOfTheWindowThenSendsTheDenial() async throws {
        let store = defaults()
        await killInsideTheWindow(record, defaults: store)
        date += 2

        let clock = ManualTestClock()
        let relaunched = denials(clock: clock, defaults: store)
        let resume = Task { await relaunched.resumePersisted() }
        await clock.advance(by: .milliseconds(2_999))
        XCTAssertEqual(events, [], "Three seconds of the window remain")
        await clock.advance(by: .milliseconds(1))
        await resume.value
        XCTAssertEqual(events, ["send head-s1"])
        await denials(clock: ManualTestClock(), defaults: store).resumePersisted()
        XCTAssertEqual(events, ["send head-s1"], "A sent denial leaves nothing for the next launch")
    }

    func testUndoAfterARelaunchInsideTheWindowSendsNothing() async throws {
        let store = defaults()
        await killInsideTheWindow(record, defaults: store)
        date += 2

        // Undo may relaunch the process and run before the launch resumes the stored denials.
        let relaunched = denials(clock: ManualTestClock(), defaults: store)
        let undone = await relaunched.undo(publisherID: record.publisherID, sessionID: "s1")
        await relaunched.resumePersisted()

        XCTAssertTrue(undone)
        XCTAssertEqual(events, ["restore head-s1"])
    }

    func testADenialWhoseWindowEndedWhileKilledIsSentAtLaunch() async throws {
        let store = defaults()
        await killInsideTheWindow(record, defaults: store)
        date += 60

        await denials(clock: ManualTestClock(), defaults: store).resumePersisted()
        XCTAssertEqual(events, ["send head-s1"])
    }
}
