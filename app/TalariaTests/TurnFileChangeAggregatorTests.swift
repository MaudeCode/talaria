import XCTest
@testable import Talaria

/// The in-chat "N files changed" recap (issue #316, Slice D) over the server's per-turn
/// `file_changes` (TAL-355): scene decoding, rename handling, and the `git/status` join for
/// counts + chips. Tool-name attribution and path normalization are server-tested.
final class TurnFileChangeAggregatorTests: XCTestCase {

    private func change(_ path: String, _ action: TurnFileChange.Action = .edited) -> AssistantTurnFileChange {
        AssistantTurnFileChange(path: path, action: action)
    }

    private func status(_ json: String) throws -> GitStatus {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try XCTUnwrap(try decoder.decode(GitStatusResponse.self, from: Data(json.utf8)).git)
    }

    private func scene(_ json: String) throws -> AssistantActivityScene {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(AssistantActivityScene.self, from: Data(json.utf8))
    }

    // MARK: - Scene field

    func testSceneDecodesServerFileChangesLossily() throws {
        let decoded = try scene("""
        {"version": "activity_scene_v1", "activity_rows": [], "file_changes": [
          {"path": "Sources/App.swift", "action": "edited"},
          {"path": "new/name.swift", "action": "renamed"},
          {"path": "future.swift", "action": "chmodded"},
          {"path": "", "action": "added"},
          {"action": "added"},
          "bad"
        ]}
        """)
        XCTAssertEqual(decoded.fileChanges, [change("Sources/App.swift"), change("new/name.swift", .renamed)])
    }

    func testSceneFromOlderWebHasNoFileChanges() throws {
        let decoded = try scene(#"{"version": "activity_scene_v1", "activity_rows": []}"#)
        XCTAssertNil(decoded.fileChanges)
        XCTAssertEqual(TurnFileChangeAggregator.summarize(changes: decoded.fileChanges ?? [], status: nil), .empty)
    }

    // MARK: - Recap

    func testMultiFileChangesKeepServerOrderAndJoinCounts() throws {
        let gitStatus = try status("""
        {"git": {"is_git": true, "files": [
          {"path": "README.md", "status": "M", "unstaged": true, "additions": 12, "deletions": 5},
          {"path": "Sources/App.swift", "status": "M", "unstaged": true, "additions": 30, "deletions": 2}
        ]}}
        """)
        let summary = TurnFileChangeAggregator.summarize(
            changes: [change("Sources/App.swift"), change("README.md")],
            status: gitStatus
        )

        XCTAssertEqual(summary.changes.map(\.path), ["Sources/App.swift", "README.md"])
        XCTAssertEqual(summary.changes.map(\.additions), [30, 12])
        XCTAssertEqual(summary.changes.map(\.deletions), [2, 5])
        XCTAssertEqual(summary.fileCount, 2)
        XCTAssertEqual(summary.totalAdditions, 42)
        XCTAssertEqual(summary.totalDeletions, 7)
        XCTAssertTrue(summary.hasChanges)
        XCTAssertEqual(summary.changes.map(\.action), [.edited, .edited])
    }

    func testNoServerChangesShowNothing() {
        XCTAssertEqual(TurnFileChangeAggregator.summarize(changes: [], status: nil), .empty)
    }

    func testRenameShowsTheServerDestinationWithRenamedChip() {
        let summary = TurnFileChangeAggregator.summarize(changes: [change("new/name.swift", .renamed)], status: nil)

        XCTAssertEqual(summary.changes.map(\.path), ["new/name.swift"])
        XCTAssertEqual(summary.changes.first?.action, .renamed)
        XCTAssertEqual(summary.changes.first?.changeKind, .renamed)
    }

    // MARK: - git/status join

    func testJoinUsesStatusCountsAndChangeKind() throws {
        let gitStatus = try status("""
        {"git": {"is_git": true, "files": [
          {"path": "new.swift", "status": "A", "staged": true, "additions": 9, "deletions": 0},
          {"path": "gone.swift", "status": "D", "staged": true, "additions": 0, "deletions": 7}
        ]}}
        """)
        let summary = TurnFileChangeAggregator.summarize(
            changes: [change("new.swift", .added), change("gone.swift", .deleted)],
            status: gitStatus
        )

        let added = try XCTUnwrap(summary.changes.first { $0.path == "new.swift" })
        XCTAssertEqual(added.additions, 9)
        XCTAssertEqual(added.changeKind, .added)
        XCTAssertNotNil(added.gitFile)

        let deleted = try XCTUnwrap(summary.changes.first { $0.path == "gone.swift" })
        XCTAssertEqual(deleted.deletions, 7)
        XCTAssertEqual(deleted.changeKind, .deleted)
    }

    func testJoinMatchesAbsoluteServerPathToRelativeStatusEntry() throws {
        let gitStatus = try status("""
        {"git": {"is_git": true, "files": [
          {"path": "Sources/App.swift", "status": "M", "unstaged": true, "additions": 4, "deletions": 1}
        ]}}
        """)
        let summary = TurnFileChangeAggregator.summarize(
            changes: [change("/Users/me/repo/Sources/App.swift")],
            status: gitStatus
        )

        let change = try XCTUnwrap(summary.changes.first)
        XCTAssertEqual(change.additions, 4)
        XCTAssertEqual(change.deletions, 1)
        XCTAssertNotNil(change.gitFile)
    }

    func testJoinDoesNotMatchDistinctRelativePathsSharingASuffix() throws {
        // The turn edited a relative `other/App.swift`; git status separately modified a
        // *different* file `some/other/App.swift`. The shared trailing component must not
        // make the path inherit the other file's counts/chip (suffix match is gated on the
        // longer path being absolute).
        let gitStatus = try status("""
        {"git": {"is_git": true, "files": [
          {"path": "some/other/App.swift", "status": "M", "unstaged": true, "additions": 9, "deletions": 3}
        ]}}
        """)
        let summary = TurnFileChangeAggregator.summarize(changes: [change("other/App.swift")], status: gitStatus)

        let change = try XCTUnwrap(summary.changes.first)
        XCTAssertEqual(change.path, "other/App.swift")
        XCTAssertEqual(change.additions, 0)
        XCTAssertEqual(change.deletions, 0)
        XCTAssertNil(change.gitFile)
    }

    func testUnmatchedPathShowsZeroCountsAndServerActionChip() {
        let summary = TurnFileChangeAggregator.summarize(changes: [change("untouched.swift")], status: nil)

        let change = summary.changes.first
        XCTAssertEqual(change?.additions, 0)
        XCTAssertEqual(change?.deletions, 0)
        XCTAssertEqual(change?.changeKind, .modified)
        XCTAssertNil(change?.gitFile)
        XCTAssertTrue(summary.diffFiles.isEmpty)
    }

    // MARK: - Titles

    func testTitlesPluralize() {
        let one = TurnFileChangeSummary(changes: [
            TurnFileChange(path: "a", additions: 1, deletions: 0, action: .edited, changeKind: .modified, gitFile: nil)
        ])
        XCTAssertEqual(one.capsuleTitle, "1 change")
        XCTAssertEqual(one.filesChangedTitle, "1 file changed")

        let many = TurnFileChangeSummary(changes: [
            TurnFileChange(path: "a", additions: 1, deletions: 0, action: .edited, changeKind: .modified, gitFile: nil),
            TurnFileChange(path: "b", additions: 1, deletions: 0, action: .edited, changeKind: .modified, gitFile: nil)
        ])
        XCTAssertEqual(many.capsuleTitle, "2 changes")
        XCTAssertEqual(many.filesChangedTitle, "2 files changed")
    }
}
