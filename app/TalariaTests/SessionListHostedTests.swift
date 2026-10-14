import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The Chats list and a reopened chat, hosted in process against the UI fixture (TAL-856): the row actions and the
/// selection bar a user reaches, and what a reopen or relaunch paints from the offline cache before the server answers.
/// The row swipe that reveals Archive is a system gesture; the phone check covers it (`app/docs/phone-checks.md`).
@MainActor
final class SessionListHostedTests: XCTestCase {
    private let sessionTitle = UITestFixtureURLProtocol.sessionTitle

    private func isFixtureRow(_ element: NSObject) -> Bool {
        element.accessibilityLabel?.hasPrefix(sessionTitle) == true
    }

    /// Archiving a chat removes it and offers Undo, which restores it from the server (TAL-443).
    func testUndoRestoresAnArchivedChat() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-archive-undo"], for: self)
        let window = try hostWindow(fixture.sessionList())
        let rowFound = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(rowFound, "Missing deterministic session fixture")
        let archive = try XCTUnwrap(
            row.accessibilityCustomActions?.first { $0.name == "Archive" },
            "The row offers no Archive action"
        )
        XCTAssertTrue(archive.actionHandler?(archive) ?? false, "Archive did not run")

        _ = try await requireElement(in: window, label: "Chat archived", "Archiving did not offer Undo")
        let archived = await awaitNoElement(in: window, timeout: 3, where: isFixtureRow)
        XCTAssertTrue(archived, "The archived chat stayed in the list")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Undo"))
        let restored = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(restored, "Undo did not restore the chat")
        let toastGone = await awaitNoElement(in: window, timeout: 5) { $0.accessibilityLabel == "Chat archived" }
        XCTAssertTrue(toastGone, "The toast stayed after Undo")
    }

    /// Select Chats picks rows, then one confirmed Delete removes them and ends the mode (TAL-627).
    func testSelectingChatsAndDeletingThemEndsSelectChats() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        let listed = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(listed, "Missing deterministic session fixture")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Select Chats"))
        for title in ["Fixture Session 01", "Fixture Session 02"] {
            let rowFound = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix(title) == true }
            HostedAccessibility.activate(try XCTUnwrap(rowFound, title))
        }
        _ = try await requireElement(in: window, label: "2 selected")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Delete"))
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented, "Delete asked for no confirmation")
        XCTAssertEqual(alert.title, "Delete 2 Chats?")
        XCTAssertTrue(HostedAccessibility.tap("Delete", in: alert), "The confirmation offers no Delete")

        let ended = await awaitNoElement(in: window) { $0.accessibilityLabel == "2 selected" }
        XCTAssertTrue(ended, "Select Chats kept its selection after every chat was deleted")
        let selectAgain = await awaitElement(in: window, label: "Select Chats")
        XCTAssertNotNil(selectAgain, "Select Chats did not end once every chat was deleted")
    }

    /// A relaunch paints the chats the App saw last time before `/api/sessions` answers (TAL-437): a second list on the
    /// first one's cache, with the server's answer held.
    func testRelaunchShowsTheLastChatsBeforeTheServerAnswers() async throws {
        let fixture = try FixtureApp(for: self)
        let first = try hostWindow(fixture.sessionList())
        let cached = await awaitElement(in: first, where: isFixtureRow)
        XCTAssertNotNil(cached, "Missing deterministic session fixture")
        first.isHidden = true

        FixtureLaunchArguments.scenario.append(UITestFixtureEnvironment.holdSessionListArgument)
        let relaunched = try hostWindow(fixture.sessionList())
        let painted = await awaitElement(in: relaunched, where: isFixtureRow)
        XCTAssertNotNil(painted, "The relaunch did not show the last chats before /api/sessions answered")
        fixture.releaseHeldLoads()
    }

    /// Reopening a chat paints its cached transcript and shows "Syncing messages" until the server answers, and no
    /// stream status competes with it (TAL-436).
    func testReopenedChatShowsSyncingUntilTheServerAnswers() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads"], for: self)
        let session = try await fixture.session()
        let first = try hostWindow(fixture.chat(session))
        let loaded = await awaitElement(in: first) { $0.accessibilityLabel?.hasPrefix("Fixture message 1 ") == true }
        XCTAssertNotNil(loaded, "The chat's first load never answered")
        first.isHidden = true

        let reopened = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server", "The reopened chat never showed Syncing messages")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Hermes is checking the response stream"), "Checking stream competed with Syncing messages")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Hermes is reconnecting the response stream"), "Reconnecting stream competed with Syncing messages")

        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced, "Syncing messages stayed after the server answered")
    }

    /// A server that reports the Agent's `state.db` as corrupt gets one notice above the Chats list that VoiceOver
    /// reads with the server's reason (TAL-830).
    func testChatsListShowsTheServersCorruptAgentStorageNotice() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.corruptAgentStorageArgument], for: self)
        let window = try hostWindow(fixture.sessionList())

        let found = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix("Agent session storage is damaged") == true }
        let notice = try XCTUnwrap(found, "No storage notice. Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertTrue(
            notice.accessibilityLabel?.contains(UITestFixtureEnvironment.corruptAgentStorageReason) == true,
            "VoiceOver does not read the server's reason: \(notice.accessibilityLabel ?? "nil")"
        )
        XCTAssertEqual(HostedAccessibility.elements(in: window, labelContaining: "Agent session storage").count, 1)
    }

    /// Healthy storage shows no notice (TAL-830).
    func testChatsListShowsNoStorageNoticeWhenTheServerReportsOK() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        let listed = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(listed, "Missing deterministic session fixture")

        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Agent session").isEmpty)
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "hermes-agent").isEmpty)
    }

    /// Each degraded state reads its own notice with the server's reason, and `ok` or no state shows none (TAL-830).
    func testAgentStorageBannerReadsEachDegradedState() throws {
        let notices: [(AgentStorage.State, String)] = [
            (.corrupt, "Agent session storage is damaged"),
            (.unavailable, "Agent sessions could not be read"),
            (.outdated, "Upgrade hermes-agent to list Agent sessions"),
        ]
        for (state, title) in notices {
            let window = try hostWindow(AgentStorageBanner(storage: AgentStorage(state: state, reason: "Synthetic reason")))
            let labels = HostedAccessibility.labels(in: window)
            XCTAssertEqual(labels.count, 1, "\(state): \(labels)")
            XCTAssertTrue(labels.first?.hasPrefix(title) == true, "\(state): \(labels)")
            XCTAssertTrue(labels.first?.contains("Synthetic reason") == true, "\(state): \(labels)")
        }
        for storage in [AgentStorage(state: .ok, reason: nil), nil] {
            let window = try hostWindow(AgentStorageBanner(storage: storage))
            XCTAssertEqual(HostedAccessibility.labels(in: window), [], "\(String(describing: storage))")
        }
    }

    /// A New Chat whose session fails to start says so in its composer, with Send off, and Retry starts it (TAL-636).
    func testNewChatReportsAFailedStartInItsComposerAndRetries() async throws {
        let fixture = try FixtureApp(["--ui-test-fail-first-session-creation"], for: self)
        let window = try hostWindow(fixture.sessionList())
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))

        let retry = try await requireElement(in: window, label: "Retry", "The composer does not offer Retry after a failed start")
        let send = HostedAccessibility.element(in: window, label: "Send")
        XCTAssertTrue(send?.accessibilityTraits.contains(.notEnabled) ?? true, "Send is enabled before the chat started")
        HostedAccessibility.activate(retry)
        _ = try await requireElement(in: window, label: "Select model", "Retry did not start the chat")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Retry"))
    }
}
