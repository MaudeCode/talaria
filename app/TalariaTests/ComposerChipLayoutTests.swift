import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-484: a composer chip shows its full title or only its icon, never a title cut to an
/// ellipsis. A truncated title stretches to whatever width the row offers, while either complete
/// form keeps its own width, so below the full title the chip's fitted width must not follow the
/// offer. The model and reasoning chips share `ComposerChipContent` inside a flexible frame that
/// fills any offer, so their width cannot show the collapse.
@MainActor
final class ComposerChipLayoutTests: XCTestCase {
    private let title = "feature/a-branch-name-too-long-for-a-narrow-composer"

    func testWorkspaceChipShowsItsIconOnlyWhenTheTitleDoesNotFit() {
        assertShowsFullTitleOrIconOnly(
            ComposerSecondaryBarLabel(
                title: title,
                systemImage: "folder",
                verticalPadding: 8,
                horizontalPadding: 14,
                color: .secondary,
                controlFont: AppFont.footnote(),
                chevronFont: AppFont.caption2()
            )
        )
    }

    func testGitBranchChipShowsItsIconOnlyWhenTheBranchDoesNotFit() {
        assertShowsFullTitleOrIconOnly(
            GitBranchPickerButton(
                currentBranch: title,
                branches: nil,
                isLoading: false,
                isSwitching: false,
                isDisabled: false,
                onSelect: { _ in },
                onCreate: { _ in },
                onRefresh: {}
            )
        )
    }

    private func assertShowsFullTitleOrIconOnly(
        _ chip: some View,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let host = UIHostingController(rootView: chip)
        func fittedWidth(offered: CGFloat) -> CGFloat {
            host.sizeThatFits(in: CGSize(width: offered, height: 200)).width
        }
        let full = fittedWidth(offered: 10_000)
        let collapsed = fittedWidth(offered: 1)
        XCTAssertLessThan(collapsed, full - 100, "The narrowest chip must drop its title", file: file, line: line)

        let partialTitleOffers = stride(from: collapsed + 1, to: full - 1, by: 4).filter { offered in
            abs(fittedWidth(offered: offered) - collapsed) > 0.5
        }
        XCTAssertEqual(
            partialTitleOffers.map { Int($0) },
            [],
            "At these offered widths the chip showed part of its title instead of only its icon",
            file: file,
            line: line
        )
        XCTAssertEqual(fittedWidth(offered: full), full, accuracy: 0.5, "A chip that fits keeps its full title", file: file, line: line)
    }
}
