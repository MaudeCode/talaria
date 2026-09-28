import SwiftMath
import SwiftUI
import UIKit
import TalariaKit

/// Renders block/display LaTeX (`$$…$$`, `\[…\]`) with the SwiftMath TeX
/// layout engine when the expression parses, and falls back to the Unicode
/// approximation (`MarkdownMathFormatter`) for anything SwiftMath can't parse.
///
/// Tolerant by design: an unparseable or partial expression degrades to the
/// previous Unicode rendering instead of crashing or showing SwiftMath's
/// inline red error. The Unicode approximation is also used as the VoiceOver
/// label on both paths, so the drawn math stays accessible.
struct DisplayMathView: View {
    let latex: String

    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var mathFontSize: CGFloat = 18

    var body: some View {
        Group {
            if MathLaTeX.isRenderable(latex) {
                ScrollView(.horizontal, showsIndicators: false) {
                    SwiftMathLabelView(
                        latex: latex,
                        fontSize: mathFontSize,
                        colorScheme: colorScheme
                    )
                    .padding(.vertical, 8)
                }
            } else {
                fallback
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(approximation)
        .padding(.vertical, 2)
        // Math/LaTeX is read left-to-right regardless of the chat direction (#259);
        // mirroring it would reverse equations inside an RTL message.
        .forcedLeftToRight()
    }

    /// The pre-SwiftMath Unicode/serif rendering, kept verbatim as the graceful
    /// fallback for expressions SwiftMath cannot parse.
    private var fallback: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(approximation)
                .font(.system(.body, design: .serif))
                .lineSpacing(4)
                .fixedSize(horizontal: true, vertical: true)
                .padding(.vertical, 8)
                .textSelection(.enabled)
        }
    }

    private var approximation: String {
        MarkdownMathFormatter.renderedText(for: latex)
    }
}

enum MathLaTeX {
    /// Renderability is a pure, deterministic function of the trimmed LaTeX
    /// string, so we memoize it. `DisplayMathView`/`MathFenceOrCodeBlock`
    /// re-check on every layout pass, and markdown-ui rebuilds code blocks on
    /// each streaming chunk — without this cache the same expression is parsed
    /// many times over. `NSCache` is thread-safe and self-evicts under memory
    /// pressure.
    nonisolated(unsafe) private static let renderableCache = NSCache<NSString, NSNumber>()

    /// True when SwiftMath can parse `latex` into a math list without error.
    /// Used to choose the SwiftMath path vs. the Unicode fallback before the
    /// `MTMathUILabel` is ever mounted, so failures never reach the screen.
    static func isRenderable(_ latex: String) -> Bool {
        let trimmed = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let key = trimmed as NSString
        if let cached = renderableCache.object(forKey: key) {
            return cached.boolValue
        }

        var error: NSError?
        let mathList = MTMathListBuilder.build(fromString: trimmed, error: &error)
        let renderable = error == nil && mathList != nil
        renderableCache.setObject(NSNumber(value: renderable), forKey: key)
        return renderable
    }
}

/// Wraps SwiftMath's `MTMathUILabel` (a UIKit view) for use in SwiftUI.
/// Sized to its intrinsic content so long equations scroll horizontally in the
/// surrounding `ScrollView` instead of clipping.
