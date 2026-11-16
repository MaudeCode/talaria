import Foundation

/// Pure helpers for revealing streamed assistant text at word boundaries.
///
/// A drainable "unit" is one word plus its trailing whitespace; leading
/// whitespace attaches to the first unit, and a trailing in-progress word counts
/// as a unit so buffers without whitespace still drain. Splitting walks
/// `Character`s (grapheme clusters), so emoji/ZWJ sequences and combining marks
/// are never split, and every split reproduces the input exactly — revealing
/// can never alter final content.
enum StreamingWordDrain {
    /// Number of drainable word units in `text`.
    static func unitCount(in text: String) -> Int {
        var count = 0
        var hasSeenNonWhitespace = false
        var previousWasWhitespace = false
        for character in text {
            let isWhitespace = character.isWhitespace
            if count == 0 {
                count = 1
            } else if previousWasWhitespace, !isWhitespace, hasSeenNonWhitespace {
                count += 1
            }
            if !isWhitespace {
                hasSeenNonWhitespace = true
            }
            previousWasWhitespace = isWhitespace
        }
        return count
    }

    /// Splits `text` after its first `unitCount` units; `head + tail == text`.
    /// A non-positive count returns everything in `tail`; a count at or beyond
    /// the backlog returns everything in `head`.
    static func splitAtUnitBoundary(_ text: String, unitCount: Int) -> (head: String, tail: String) {
        guard unitCount > 0, !text.isEmpty else { return ("", text) }

        var unitsSeen = 0
        var hasSeenNonWhitespace = false
        var previousWasWhitespace = false
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            let isWhitespace = character.isWhitespace
            if unitsSeen == 0 {
                unitsSeen = 1
            } else if previousWasWhitespace, !isWhitespace, hasSeenNonWhitespace {
                unitsSeen += 1
                if unitsSeen > unitCount {
                    return (String(text[..<index]), String(text[index...]))
                }
            }
            if !isWhitespace {
                hasSeenNonWhitespace = true
            }
            previousWasWhitespace = isWhitespace
            index = text.index(after: index)
        }
        return (text, "")
    }

    /// TAL-1410: what one coalesced reveal tick shows. Everything buffered
    /// through the last whitespace shows at once; the trailing partial word is
    /// held so it never appears half-typed, but only for one tick. When the
    /// previous tick held a fragment and no whitespace has arrived since, the
    /// whole buffer shows, so CJK text, long URLs and code never stall.
    /// `shown + held == pending`.
    static func revealCut(_ pending: String, heldPreviousTick: Bool) -> (shown: String, held: String) {
        guard let lastWhitespace = pending.lastIndex(where: \.isWhitespace) else {
            return heldPreviousTick ? (pending, "") : ("", pending)
        }
        let boundary = pending.index(after: lastWhitespace)
        return (String(pending[..<boundary]), String(pending[boundary...]))
    }
}
