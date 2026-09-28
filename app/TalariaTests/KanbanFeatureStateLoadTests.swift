import XCTest
@testable import Talaria
@testable import TalariaKit

// Asserts plural wording from the App's string catalog, which only the App bundle carries.
@MainActor
extension KanbanFeatureStateTests {
    func testCanonicalStatusAndCardAccessibilityCopy() throws {
        XCTAssertEqual(KanbanStatusPresentation("triage").title, String(localized: "Triage"))
        XCTAssertEqual(KanbanStatusPresentation("todo").title, String(localized: "To Do"))
        XCTAssertEqual(KanbanStatusPresentation("ready").title, String(localized: "Ready"))
        XCTAssertEqual(KanbanStatusPresentation("running").title, String(localized: "Running"))
        XCTAssertEqual(KanbanStatusPresentation("blocked").title, String(localized: "Blocked"))
        XCTAssertEqual(KanbanStatusPresentation("done").title, String(localized: "Done"))
        XCTAssertEqual(KanbanStatusPresentation("archived").title, String(localized: "Archived"))
        XCTAssertTrue(KanbanStatusPresentation("future").title.contains("future"))

        let card = try XCTUnwrap(KanbanFixtures.richSnapshot.columns?[1].cards?.first)
        let summary = KanbanCardAccessibility.summary(card)
        XCTAssertTrue(summary.contains("CARD-1"))
        XCTAssertTrue(summary.contains("Status Focus"))
        XCTAssertTrue(summary.contains(String(localized: "Ready")))
        XCTAssertTrue(summary.contains("builder"))
        XCTAssertTrue(summary.contains("mobile"))
        XCTAssertTrue(KanbanBulkAccessibility.selectionLabel(card, isSelected: true).contains(String(localized: "Selected")))
        XCTAssertFalse(KanbanBulkAccessibility.selectionLabel(card, isSelected: false).contains(String(localized: "Selected")))
        let bulkSummary = KanbanBulkActionSummary(
            action: .changeStatus("done"),
            members: [
                KanbanBulkMemberResult(cardID: "CARD-1", cardTitle: "First", outcome: .succeeded),
                KanbanBulkMemberResult(cardID: "CARD-2", cardTitle: "Second", outcome: .failed),
                KanbanBulkMemberResult(cardID: "CARD-3", cardTitle: "Third", outcome: .outcomeUncertain)
            ]
        )
        let bulkLabel = KanbanBulkAccessibility.resultLabel(bulkSummary)
        XCTAssertTrue(bulkLabel.contains("1 \(String(localized: "Complete"))"))
        XCTAssertTrue(bulkLabel.contains("1 \(String(localized: "Failed"))"))
        XCTAssertTrue(bulkLabel.contains("1 \(String(localized: "Outcome Uncertain"))"))
        XCTAssertEqual(KanbanCountFormatter.cards(1), "1 Card")
        XCTAssertEqual(KanbanCountFormatter.cards(2), "2 Cards")
        let board: KanbanBoard = mutationDecode(
            #"{"slug":"release","name":"Release"}"#
        )
        XCTAssertEqual(KanbanBoardAccessibility.browseLabel(board), "Browse Board: Release")
        XCTAssertEqual(KanbanBoardAccessibility.actionsLabel(board), "Board actions for Release")
        XCTAssertEqual(
            KanbanBoardAccessibility.statusValue(isBrowsing: true, isActive: true),
            "\(String(localized: "Browsing")), \(String(localized: "Active"))"
        )
        let describedBoard: KanbanBoard = mutationDecode(
            #"{"slug":"release","name":"Release","description":"Release planning","total":3}"#
        )
        XCTAssertEqual(
            KanbanBoardAccessibility.browseSummary(describedBoard, isActive: true),
            "Browse Board: Release, Release planning, 3 Cards, Active"
        )

        let dispatchResult: KanbanDispatchResult = mutationDecode(
            #"{"spawned":[{"id":"secret"}],"promoted":2,"reclaimed":0,"skipped_unassigned":[],"skipped_nonspawnable":[],"auto_blocked":[],"timed_out":[],"crashed":[]}"#
        )
        let dispatchLabel = KanbanDispatchAccessibility.summary(
            KanbanDispatchState(
                mode: .preview,
                boardSlug: "main",
                phase: .succeeded,
                result: dispatchResult,
                completedAt: nil,
                boardActivityGeneration: 1
            ),
            isStale: true
        )
        XCTAssertTrue(dispatchLabel.contains(String(localized: "Preview Dispatch")))
        XCTAssertTrue(dispatchLabel.contains("\(String(localized: "Spawned")): 1"))
        XCTAssertTrue(dispatchLabel.contains("\(String(localized: "Promoted")): 2"))
        XCTAssertTrue(dispatchLabel.contains(String(localized: "This Preview is stale. Run Preview Dispatch again before relying on it.")))
        XCTAssertFalse(dispatchLabel.contains("secret"))
        let submittingLabel = KanbanDispatchAccessibility.summary(
            KanbanDispatchState(
                mode: .run,
                boardSlug: "main",
                phase: .submitting,
                result: nil,
                completedAt: nil,
                boardActivityGeneration: 1
            ),
            isStale: false
        )
        XCTAssertTrue(submittingLabel.contains(String(localized: "Running Dispatcher...")))
        XCTAssertFalse(submittingLabel.contains(String(localized: "Updating task...")))
        XCTAssertEqual(
            KanbanDispatchCopy.runConfirmation,
            "This may start up to \(KanbanDispatchRequest.maximum) workers and consume API budget."
        )
    }
}
