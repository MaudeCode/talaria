import XCTest
@testable import TalariaKit

final class ComposerModelPickerSectionExpansionStateTests: XCTestCase {
    func testProvidersStartOpenAndRestoreOnlyExplicitCollapses() {
        var state = ComposerModelPickerSectionExpansionState()
        XCTAssertTrue(state.isExpanded(groupID: "alpha"), "Every provider must start open")
        state.setExpanded(false, groupID: "alpha")
        var reopened = ComposerModelPickerSectionExpansionState(collapsedGroupIDs: state.collapsedGroupIDs)
        XCTAssertFalse(reopened.isExpanded(groupID: "alpha"), "Even the selected provider stays collapsed on reopen")
        XCTAssertTrue(reopened.isExpanded(groupID: "new-provider"))
        for query in ["matching model", "\0alpha"] {
            reopened.updateSearchText(query)
            XCTAssertTrue(reopened.isExpanded(groupID: "alpha"))
            reopened.setExpanded(false, groupID: "alpha")
            XCTAssertTrue(reopened.isExpanded(groupID: "alpha"), "Search and single-provider filtering keep matches visible")
            XCTAssertEqual(reopened.collapsedGroupIDs, ["alpha"])
        }
        reopened.updateSearchText("   ")
        XCTAssertFalse(reopened.isExpanded(groupID: "alpha"))
        reopened.setExpanded(true, groupID: "alpha")
        XCTAssertTrue(ComposerModelPickerSectionExpansionState(collapsedGroupIDs: reopened.collapsedGroupIDs).isExpanded(groupID: "alpha"))
    }
}
