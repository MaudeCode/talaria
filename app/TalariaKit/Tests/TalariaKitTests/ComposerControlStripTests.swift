import XCTest
@testable import TalariaKit

/// TAL-629: the composer's control strip shows its selectors in a fixed order and fades only an
/// edge that hides controls.
final class ComposerControlStripTests: XCTestCase {
    func testSelectorsFollowWorkspaceBranchProfileOrder() {
        XCTAssertEqual(
            state(workspace: "talaria", branch: "main", profile: "Work").selectors,
            [.workspace, .gitBranch, .profile]
        )
    }

    func testHiddenSelectorsDropOutWithoutReordering() {
        XCTAssertEqual(state(workspace: nil, branch: "main", profile: "Work").selectors, [.gitBranch, .profile])
        XCTAssertEqual(state(workspace: "talaria", branch: nil, profile: nil).selectors, [.workspace])
        XCTAssertEqual(state(workspace: nil, branch: nil, profile: nil).selectors, [])
    }

    func testContentThatFitsHasNoFade() {
        XCTAssertEqual(
            ComposerStripEdgeFades(contentOffset: 0, contentWidth: 300, containerWidth: 320),
            ComposerStripEdgeFades(leading: false, trailing: false)
        )
    }

    func testOverflowFadesOnlyTheEdgesThatHideContent() {
        XCTAssertEqual(
            ComposerStripEdgeFades(contentOffset: 0, contentWidth: 480, containerWidth: 320),
            ComposerStripEdgeFades(leading: false, trailing: true)
        )
        XCTAssertEqual(
            ComposerStripEdgeFades(contentOffset: 80, contentWidth: 480, containerWidth: 320),
            ComposerStripEdgeFades(leading: true, trailing: true)
        )
        XCTAssertEqual(
            ComposerStripEdgeFades(contentOffset: 160, contentWidth: 480, containerWidth: 320),
            ComposerStripEdgeFades(leading: true, trailing: false)
        )
    }

    func testSubpointRoundingDoesNotFade() {
        XCTAssertEqual(
            ComposerStripEdgeFades(contentOffset: 0.3, contentWidth: 320.4, containerWidth: 320),
            ComposerStripEdgeFades(leading: false, trailing: false)
        )
    }

    private func state(workspace: String?, branch: String?, profile: String?) -> ComposerSecondaryControlsState {
        ComposerSecondaryControlsState(
            workspaceTitle: workspace,
            profileOptions: [],
            selectedProfileName: nil,
            selectedProfileTitle: profile,
            gitBranch: branch.map { .init(currentName: $0, branches: nil, isLoading: false, isSwitching: false) },
            isDisabled: false
        )
    }
}
