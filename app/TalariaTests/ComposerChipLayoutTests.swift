import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-484: a composer control shows its full title or only its icon, never a title cut to an
/// ellipsis. A truncated title stretches to whatever width the row offers, while either complete
/// form keeps its own width, so below the full title the fitted width must not follow the offer.
/// Every strip control (TAL-629) wraps `ComposerChipContent` in a flexible frame that fills any
/// offer, so the collapse is pinned on the shared content itself.
@MainActor
final class ComposerChipLayoutTests: XCTestCase {
    private let title = "feature/a-branch-name-too-long-for-a-narrow-composer"

    func testControlShowsItsIconOnlyWhenTheTitleDoesNotFit() {
        assertShowsFullTitleOrIconOnly(
            ComposerChipContent(title: title, spacing: 5, font: AppFont.footnote()) {
                Image(systemName: "arrow.triangle.branch")
            } trailing: {
                Image(systemName: "chevron.down")
            }
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
