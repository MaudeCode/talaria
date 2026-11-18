import XCTest
@testable import Talaria
@testable import TalariaKit

// Asserts plural wording from the App's string catalog, which only the App bundle carries.
@MainActor
extension KanbanFeatureStateTests {
    func testCardCountUsesTheCatalogSingular() {
        XCTAssertEqual(KanbanCountFormatter.cards(1), "1 Card")
    }
}
