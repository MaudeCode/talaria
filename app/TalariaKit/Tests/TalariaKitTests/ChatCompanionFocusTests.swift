import XCTest
@testable import TalariaKit

/// TAL-1458: the file a chat's companion page shows, from the server's `focus_path` on the shared fixture's frames.
@MainActor
final class ChatCompanionFocusTests: XCTestCase {
    private let server = URL(string: "https://companion.test")!

    func testTheFollowedPageMovesToEachFileCallAndKeepsItThroughOtherCalls() throws {
        let chat = try makeChat()
        chat.streamCoordinatorAppendToolCall(try frame("tool_a"))
        XCTAssertEqual(chat.companionFocus.path, "Sources/Demo/Alpha.swift")

        // A bare completion (no arguments, so no focus path) brings its call's change by id.
        chat.streamCoordinatorCompleteToolCall(try toolEvent(#"{"id": "call-alpha", "name": "write_file", "edit_diff": \#(editDiffJSON)}"#))
        XCTAssertEqual(chat.companionFocus.shownEditDiff?.added, 1)

        chat.streamCoordinatorAppendToolCall(try frame("tool_b"))
        XCTAssertEqual(chat.companionFocus.path, "Sources/Demo/Beta.swift")
        XCTAssertNil(chat.companionFocus.shownEditDiff, "The new file shows the change of the call before it")

        chat.streamCoordinatorAppendToolCall(try frame("shell"))
        XCTAssertEqual(chat.companionFocus.path, "Sources/Demo/Beta.swift", "A shell call moved the page")
    }

    func testAPinnedFileHoldsUntilFollowResumes() throws {
        let chat = try makeChat()
        chat.streamCoordinatorAppendToolCall(try frame("tool_a"))
        chat.pinCompanionFile("Sources/Demo/Gamma.swift")
        chat.streamCoordinatorAppendToolCall(try frame("tool_b"))
        XCTAssertEqual(chat.companionFocus.path, "Sources/Demo/Gamma.swift")
        XCTAssertFalse(chat.companionFocus.isFollowing)

        chat.followCompanionFocus()
        XCTAssertEqual(chat.companionFocus.path, "Sources/Demo/Beta.swift")
        XCTAssertTrue(chat.companionFocus.isFollowing)
    }

    func testAnotherRunResumesFollowingButAReconnectToThePinsRunDoesNot() {
        var focus = ChatCompanionFocus()
        focus.follow("a.swift")
        focus.pin("b.swift", runID: "run-1")
        focus.runStarted("run-1")
        XCTAssertEqual(focus.path, "b.swift")
        focus.runStarted("run-2")
        XCTAssertEqual(focus.path, "a.swift")

        focus.pin("c.swift", runID: nil)
        focus.runStarted("run-3")
        XCTAssertEqual(focus.path, "a.swift", "A pin made while idle held into the next run")
    }

    /// TAL-1478: a tool result pins the page over its file; Back and Follow return to the file, a new run follows again, and
    /// the shown call's later state replaces it without re-pinning.
    func testAToolResultPinsThePageUntilBackFollowOrTheNextRun() {
        var focus = ChatCompanionFocus()
        focus.follow("a.swift")
        let call = ToolCall(id: "call", name: "terminal", preview: nil, args: nil)
        focus.show(.toolResult(call), runID: nil)
        XCTAssertEqual(focus.shownToolCallID, "call")
        XCTAssertFalse(focus.isFollowing)
        var finished = call
        finished.isCompleted = true
        focus.show(.toolResult(finished), runID: "run-2")
        XCTAssertEqual(focus.shown, .toolResult(finished))
        focus.back()
        XCTAssertNil(focus.shown)
        XCTAssertTrue(focus.isFollowing, "Back left the page pinned")

        focus.show(.toolResult(call), runID: "run-1")
        focus.runStarted("run-1")
        XCTAssertNotNil(focus.shown, "A reconnect to the result's run dropped it")
        focus.runStarted("run-2")
        XCTAssertNil(focus.shown)
        XCTAssertEqual(focus.path, "a.swift")

        focus.show(.toolResult(call), runID: nil)
        focus.pin("b.swift", runID: nil)
        XCTAssertNil(focus.shown, "A chosen file stayed under the tool result")
        XCTAssertEqual(focus.path, "b.swift")
    }

    /// TAL-1478: a running call shown on the page takes its completion from the stream, whether or not its card is drawn.
    func testTheShownToolResultTakesItsCallsCompletionWithoutItsCard() throws {
        let chat = try makeChat(id: "-shown")
        chat.streamCoordinatorAppendToolCall(try frame("tool_a"))
        chat.showOnCompanionPage(.toolResult(try XCTUnwrap(chat.liveToolCalls.last)))
        chat.streamCoordinatorCompleteToolCall(try toolEvent(#"{"id": "call-alpha", "name": "write_file", "edit_diff": \#(editDiffJSON)}"#))
        guard case .toolResult(let shown) = chat.companionFocus.shown else { return XCTFail("The page lost its tool result") }
        XCTAssertTrue(shown.isCompleted, "The page kept the running call")
        XCTAssertEqual(shown.editDiff?.added, 1)
    }

    /// TAL-1478: Back steps from a changed file's diff to the turn's list, then to the pinned file under it.
    func testBackStepsFromAChangedFileToTheListThenToThePinnedFile() throws {
        var focus = ChatCompanionFocus()
        focus.follow("a.swift")
        focus.pin("b.swift", runID: nil)
        let file = try JSONDecoder().decode(GitFile.self, from: Data(#"{"path": "a.swift", "diffKind": "unstaged"}"#.utf8))
        focus.show(.turnChanges([file], opened: file), runID: nil)
        focus.back()
        XCTAssertEqual(focus.shown, .turnChanges([file], opened: nil))
        focus.back()
        XCTAssertNil(focus.shown)
        XCTAssertEqual(focus.path, "b.swift")
        XCTAssertFalse(focus.isFollowing, "Back dropped the reader's pin")
    }

    func testAnEarlierCallsCompletionDoesNotTurnThePageBack() {
        var focus = ChatCompanionFocus()
        focus.follow("a.swift", callID: "a")
        focus.follow("b.swift", callID: "b")
        focus.complete("a.swift", callID: "a", editDiff: nil)
        XCTAssertEqual(focus.path, "b.swift")
    }

    func testOnlyAChatRebuiltFromMemoryTakesTheDetailsFile() {
        var focus = ChatCompanionFocus()
        focus.follow("a.swift", callID: "a")
        focus.seed("b.swift")
        XCTAssertEqual(focus.path, "a.swift", "A detail read mid-run turned the page back")
        focus.forgetLiveCalls()
        focus.seed("b.swift")
        XCTAssertEqual(focus.path, "b.swift", "A reopened chat kept the file it remembered")
    }

    func testTheChatARebuildMakesShowsTheSamePage() throws {
        let chat = try makeChat()
        chat.streamCoordinatorAppendToolCall(try frame("tool_a"))
        chat.pinCompanionFile("Sources/Demo/Gamma.swift")
        chat.showCompanionBrowser(at: "Sources")

        let rebuilt = try makeChat()
        XCTAssertEqual(rebuilt.companionFocus.path, "Sources/Demo/Gamma.swift")
        XCTAssertEqual(rebuilt.companionFocus.followedPath, "Sources/Demo/Alpha.swift")
        XCTAssertEqual(rebuilt.companionFocus.browserPath, "Sources")
    }

    /// TAL-1539: a page the reader hid stays hidden through new files and the chat a fold rebuilds.
    func testAHiddenPageStaysHiddenThroughNewFilesAndRebuilds() throws {
        let chat = try makeChat()
        chat.streamCoordinatorAppendToolCall(try frame("tool_a"))
        XCTAssertFalse(chat.companionFocus.isHidden)
        chat.setCompanionPageHidden(true)
        chat.streamCoordinatorAppendToolCall(try frame("tool_b"))
        XCTAssertTrue(chat.companionFocus.isHidden, "A new file reopened the page")
        XCTAssertTrue(try makeChat().companionFocus.isHidden, "The rebuilt chat showed the hidden page")

        chat.setCompanionPageHidden(false)
        XCTAssertFalse(try makeChat().companionFocus.isHidden)
    }

    /// TAL-1539: with Open the Agent's File Automatically off, a chat starts with its page hidden.
    func testTheAutoOpenSettingDecidesWhetherANewChatStartsHidden() throws {
        let suite = "ChatCompanionFocusTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        XCTAssertFalse(try makeChat(defaults: defaults, id: "on").companionFocus.isHidden, "The setting is on by default")
        defaults.set(false, forKey: ChatTranscriptDisplaySettings.opensCompanionPageKey)
        XCTAssertTrue(try makeChat(defaults: defaults, id: "off").companionFocus.isHidden)
    }

    func testTheSessionDetailCarriesItsLastFile() throws {
        let session = try fixture()["session"] as? [String: Any]
        var detail = try XCTUnwrap(session)
        detail["session_id"] = "companion"
        detail["title"] = "Demo"
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let decoded = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: detail))
        XCTAssertEqual(decoded.focusPath, "Sources/Demo/Gamma.swift")
    }

    private let editDiffJSON = #"{"added": 1, "removed": 0, "diff": "+struct Alpha {}", "truncated": false, "hunks": []}"#

    private func makeChat(defaults: UserDefaults? = nil, id: String = "") throws -> ChatViewModel {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let summary = try decoder.decode(SessionSummary.self, from: Data(#"{"session_id": "companion-\#(name)\#(id)", "title": "Demo"}"#.utf8))
        return ChatViewModel(
            session: summary,
            server: server,
            draftAttachmentStore: RecordingSendDraftAttachmentStore(),
            userDefaults: try defaults ?? XCTUnwrap(UserDefaults(suiteName: "ChatCompanionFocusTests.\(UUID().uuidString)"))
        )
    }

    private func fixture() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/fixtures/focus-path.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func frame(_ key: String) throws -> ToolStreamEvent {
        let event = try XCTUnwrap(fixture()[key] as? [String: Any])
        return try JSONDecoder().decode(ToolStreamEvent.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(event["data"])))
    }

    private func toolEvent(_ json: String) throws -> ToolStreamEvent {
        try JSONDecoder().decode(ToolStreamEvent.self, from: Data(json.utf8))
    }
}
