import CoreGraphics

/// The chat composer card's arrangement in its pane and the most its text may grow. A pane too short for the
/// two-row card at one line and the transcript's minimum, as on an iPhone in landscape with the keyboard up, gets the
/// card in one row: +, the text, then voice, context and send (TAL-680). A draft that grows never switches it: in two
/// rows the text stops growing where the transcript's minimum begins and scrolls inside the card (TAL-1635).
public struct ComposerCardSizing: Equatable {
    /// The transcript's share of the chat pane: room under the navigation bar for at least one row (TAL-680).
    public static let minimumTranscriptHeight: CGFloat = 96
    /// The text view's height at one line.
    public static let oneLineInputHeight: CGFloat = 22
    /// The text's tallest height before it scrolls, wherever the pane has room for it.
    public static let maximumLooseInputHeight: CGFloat = 96

    public let usesOneRowCard: Bool
    public let maximumInputHeight: CGFloat

    /// - Parameters:
    ///   - availableHeight: the pane's height for the transcript and composer; 0 while unknown.
    ///   - tabletopHeight: the composer's half of a tabletop pose, if any.
    ///   - twoRowCardHeight: the composer's height, last measured in two rows.
    ///   - twoRowInputHeight: the text's height in that same measurement.
    ///   - allowsOneRowCard: false while the composer shows its single-line shell or answers a clarification, whose
    ///     question panel takes the pane on its own; those keep the text's loose maximum.
    public init(
        availableHeight: CGFloat,
        tabletopHeight: CGFloat?,
        twoRowCardHeight: CGFloat,
        twoRowInputHeight: CGFloat,
        allowsOneRowCard: Bool
    ) {
        let chromeHeight = max(0, twoRowCardHeight - twoRowInputHeight)
        // Judged at one line, not at the draft's height, so typing cannot switch it; and against the last two-row
        // measurement, so the shorter one-row card does not switch it back.
        let roomBelowTranscript = availableHeight - Self.minimumTranscriptHeight - chromeHeight
        usesOneRowCard = tabletopHeight == nil && allowsOneRowCard && availableHeight > 0
            && roomBelowTranscript < Self.oneLineInputHeight
        if usesOneRowCard {
            maximumInputHeight = Self.oneLineInputHeight
        } else if let tabletopHeight {
            maximumInputHeight = max(Self.oneLineInputHeight, tabletopHeight - chromeHeight - 8)
        } else if allowsOneRowCard, availableHeight > 0 {
            maximumInputHeight = min(Self.maximumLooseInputHeight, max(Self.oneLineInputHeight, roomBelowTranscript))
        } else {
            maximumInputHeight = Self.maximumLooseInputHeight
        }
    }
}
