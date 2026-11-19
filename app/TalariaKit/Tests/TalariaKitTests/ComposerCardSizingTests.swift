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
        var measurement = (card: chrome + ComposerCardSizing.defaultOneLineInputHeight, input: ComposerCardSizing.defaultOneLineInputHeight)
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
        var measurement = (card: chrome + ComposerCardSizing.defaultOneLineInputHeight, input: ComposerCardSizing.defaultOneLineInputHeight)
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
        XCTAssertEqual(twoRow.maximumInputHeight, ComposerCardSizing.defaultOneLineInputHeight)
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
                                        twoRowCardHeight: chrome + 22, twoRowInputHeight: 22, oneLineInputHeight: 22,
                                        allowsOneRowCard: true)
        XCTAssertFalse(sizing.usesOneRowCard)
        XCTAssertEqual(sizing.maximumInputHeight, 200 - chrome - 8)
    }

    func testTheShellAndClarificationsNeverUseOneRowAndKeepTheLooseMaximum() {
        let sizing = ComposerCardSizing(availableHeight: landscapeKeyboardUp, tabletopHeight: nil,
                                        twoRowCardHeight: chrome + 22, twoRowInputHeight: 22, oneLineInputHeight: 22,
                                        allowsOneRowCard: false)
        XCTAssertFalse(sizing.usesOneRowCard)
        XCTAssertEqual(sizing.maximumInputHeight, ComposerCardSizing.maximumLooseInputHeight)
    }

    /// TAL-2569: at the largest accessibility size one line of body text is 64 pt. A pane with room for a default line
    /// but not that one gets the one-row card, and every arrangement leaves the text that whole line.
    func testAnAccessibilityLineDecidesTheArrangementAndIsNeverCut() {
        let line: CGFloat = 64
        let between = chrome + ComposerCardSizing.minimumTranscriptHeight + 40
        for availableHeight in [landscapeKeyboardUp, between] {
            let sizing = sizing(availableHeight: availableHeight, card: chrome + line, input: line, line: line)
            XCTAssertTrue(sizing.usesOneRowCard, "\(availableHeight) pt has no room for a \(line) pt line in two rows")
            XCTAssertEqual(sizing.maximumInputHeight, line)
        }
        XCTAssertEqual(sizing(availableHeight: 0, card: 0, input: 0, line: 120).maximumInputHeight, 120)
        let tabletop = ComposerCardSizing(availableHeight: 150, tabletopHeight: chrome + 40, twoRowCardHeight: chrome + line,
                                          twoRowInputHeight: line, oneLineInputHeight: line, allowsOneRowCard: true)
        XCTAssertEqual(tabletop.maximumInputHeight, line)
    }

    private func sizing(availableHeight: CGFloat, card: CGFloat, input: CGFloat,
                        line: CGFloat = ComposerCardSizing.defaultOneLineInputHeight) -> ComposerCardSizing {
        ComposerCardSizing(availableHeight: availableHeight, tabletopHeight: nil, twoRowCardHeight: card,
                           twoRowInputHeight: input, oneLineInputHeight: line, allowsOneRowCard: true)
    }

    /// The text view's natural height: one line, then about 20 pt per wrapped line at the body size.
    private func textHeight(lines: Int) -> CGFloat {
        ComposerCardSizing.defaultOneLineInputHeight + CGFloat(lines - 1) * 20
    }
}
