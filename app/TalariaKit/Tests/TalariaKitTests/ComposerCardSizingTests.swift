import CoreGraphics
import XCTest
@testable import TalariaKit

/// TAL-680 and TAL-1635: a pane too short for the two-row composer at one line gets the one-row card; a draft that
/// grows in a short pane keeps two rows and scrolls once the transcript's minimum is reached.
final class ComposerCardSizingTests: XCTestCase {
    /// The card around its text: padding, the control row and the strip under it.
    private let chrome: CGFloat = 100
    /// An iPhone Duo's outer display in portrait with the keyboard up: three lines fit, a fourth does not.
    private let duoOuterKeyboardUp: CGFloat = 270
    /// An iPhone in landscape with the keyboard up: not even one line fits with the transcript's minimum.
    private let landscapeKeyboardUp: CGFloat = 200

    func testAGrowingDraftOnAShortPaneKeepsTwoRows() {
        var measurement = (card: chrome + ComposerCardSizing.oneLineInputHeight, input: ComposerCardSizing.oneLineInputHeight)
        for lines in 1...6 {
            let sizing = sizing(availableHeight: duoOuterKeyboardUp, card: measurement.card, input: measurement.input)
            XCTAssertFalse(sizing.usesOneRowCard, "switched to one row with \(lines - 1) lines typed")
            guard !sizing.usesOneRowCard else { return }
            // The view measures its two-row card with the text capped, then judges the next line against that.
            let input = min(textHeight(lines: lines), sizing.maximumInputHeight)
            measurement = (chrome + input, input)
        }
    }

    func testTheTextStopsGrowingAtTheTranscriptsMinimum() {
        var measurement = (card: chrome + ComposerCardSizing.oneLineInputHeight, input: ComposerCardSizing.oneLineInputHeight)
        for lines in 1...6 {
            let sizing = sizing(availableHeight: duoOuterKeyboardUp, card: measurement.card, input: measurement.input)
            let input = min(textHeight(lines: lines), sizing.maximumInputHeight)
            XCTAssertLessThanOrEqual(chrome + input + ComposerCardSizing.minimumTranscriptHeight, duoOuterKeyboardUp,
                                     "\(lines) lines crowd out the transcript")
            measurement = (chrome + input, input)
        }
    }

    func testAPaneTooShortForOneLineUsesOneRowAndStaysThere() {
        let twoRow = sizing(availableHeight: landscapeKeyboardUp, card: chrome + 22, input: 22)
        XCTAssertTrue(twoRow.usesOneRowCard)
        XCTAssertEqual(twoRow.maximumInputHeight, ComposerCardSizing.oneLineInputHeight)
        // In one row the view keeps its last two-row measurement, so the shorter card does not switch it back.
        XCTAssertTrue(sizing(availableHeight: landscapeKeyboardUp, card: chrome + 22, input: 22).usesOneRowCard)
    }

    func testARoomyPaneGrowsTheTextToItsLooseMaximum() {
        let sizing = sizing(availableHeight: 600, card: chrome + 82, input: 82)
        XCTAssertFalse(sizing.usesOneRowCard)
        XCTAssertEqual(sizing.maximumInputHeight, ComposerCardSizing.maximumLooseInputHeight)
    }

    func testAnUnknownPaneKeepsTwoRowsAndTheLooseMaximum() {
        let sizing = sizing(availableHeight: 0, card: 0, input: 0)
        XCTAssertFalse(sizing.usesOneRowCard)
        XCTAssertEqual(sizing.maximumInputHeight, ComposerCardSizing.maximumLooseInputHeight)
    }

    func testTabletopFitsTheTextInItsHalfAndNeverUsesOneRow() {
        let sizing = ComposerCardSizing(availableHeight: 150, tabletopHeight: 200,
                                        twoRowCardHeight: chrome + 22, twoRowInputHeight: 22, allowsOneRowCard: true)
        XCTAssertFalse(sizing.usesOneRowCard)
        XCTAssertEqual(sizing.maximumInputHeight, 200 - chrome - 8)
    }

    func testTheShellAndClarificationsNeverUseOneRowAndKeepTheLooseMaximum() {
        let sizing = ComposerCardSizing(availableHeight: landscapeKeyboardUp, tabletopHeight: nil,
                                        twoRowCardHeight: chrome + 22, twoRowInputHeight: 22, allowsOneRowCard: false)
        XCTAssertFalse(sizing.usesOneRowCard)
        XCTAssertEqual(sizing.maximumInputHeight, ComposerCardSizing.maximumLooseInputHeight)
    }

    private func sizing(availableHeight: CGFloat, card: CGFloat, input: CGFloat) -> ComposerCardSizing {
        ComposerCardSizing(availableHeight: availableHeight, tabletopHeight: nil,
                           twoRowCardHeight: card, twoRowInputHeight: input, allowsOneRowCard: true)
    }

    /// The text view's natural height: one line, then about 20 pt per wrapped line at the body size.
    private func textHeight(lines: Int) -> CGFloat {
        ComposerCardSizing.oneLineInputHeight + CGFloat(lines - 1) * 20
    }
}
