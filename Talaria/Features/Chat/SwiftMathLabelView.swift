import SwiftMath
import SwiftUI
import UIKit

struct SwiftMathLabelView: UIViewRepresentable {
    let latex: String
    let fontSize: CGFloat
    let colorScheme: ColorScheme

    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.labelMode = .display
        label.textAlignment = .left
        // We pick the fallback view for unparseable input, so the inline red
        // error should never appear.
        label.displayErrorInline = false
        label.contentInsets = .zero
        configure(label)
        return label
    }

    func updateUIView(_ uiView: MTMathUILabel, context: Context) {
        configure(uiView)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: MTMathUILabel,
        context: Context
    ) -> CGSize? {
        uiView.intrinsicContentSize
    }

    /// Applies the current inputs, skipping no-op writes so repeated SwiftUI
    /// updates (e.g. during streaming) don't force needless re-typesetting.
    private func configure(_ label: MTMathUILabel) {
        if label.fontSize != fontSize {
            label.fontSize = fontSize
        }

        let textColor = Self.resolvedTextColor(for: colorScheme)
        if label.textColor != textColor {
            label.textColor = textColor
        }

        if label.latex != latex {
            label.latex = latex
        }
    }

    /// Resolves the dynamic label color against the SwiftUI color scheme so the
    /// Core Graphics-drawn math matches the surrounding text in light and dark.
    private static func resolvedTextColor(for colorScheme: ColorScheme) -> MTColor {
        let style: UIUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        return UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
    }
}
