import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit

struct ChatMarkdownTable: View {
    static let cellMinWidth: CGFloat = 96
    static let cellMaxWidth: CGFloat = 260

    let label: MarkdownUI.BlockConfiguration.Label
    let colorScheme: ColorScheme

    var body: some View {
        ScrollView(.horizontal) {
            label
                .fixedSize(horizontal: true, vertical: true)
                .markdownTableBorderStyle(.init(color: borderColor))
                .markdownTableBackgroundStyle(
                    .alternatingRows(backgroundColor, secondaryBackgroundColor)
                )
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private var backgroundColor: SwiftUI.Color {
        colorScheme == .dark
            ? SwiftUI.Color(red: 0.094, green: 0.098, blue: 0.114)
            : SwiftUI.Color.white
    }

    private var secondaryBackgroundColor: SwiftUI.Color {
        colorScheme == .dark
            ? SwiftUI.Color(red: 0.145, green: 0.149, blue: 0.165)
            : SwiftUI.Color(red: 0.969, green: 0.969, blue: 0.976)
    }

    private var borderColor: SwiftUI.Color {
        colorScheme == .dark
            ? SwiftUI.Color(red: 0.259, green: 0.267, blue: 0.306)
            : SwiftUI.Color(red: 0.894, green: 0.894, blue: 0.91)
    }
}
