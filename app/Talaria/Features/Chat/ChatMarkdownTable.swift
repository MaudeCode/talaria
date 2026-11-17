import MarkdownUI
import SwiftUI
import UIKit

/// A chat table is a reading table, like Web's (TAL-2319, TAL-2320): a rule under the header and each row but
/// the last, the header's stronger, no cell grid, no fills. A wide table scrolls inside the reading column.
struct ChatMarkdownTable: View {
    static let cellMinWidth: CGFloat = 96
    static let cellMaxWidth: CGFloat = 260

    let label: MarkdownUI.BlockConfiguration.Label

    var body: some View {
        ScrollView(.horizontal) {
            Self.readingTable(label)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    /// The table without its scroll view, which `ImageRenderer` would draw empty in visual references.
    /// The rules are drawn here rather than by MarkdownUI's border style, which has no per-row colour.
    static func readingTable(_ label: some View) -> some View {
        label
            .fixedSize(horizontal: true, vertical: true)
            .markdownTableBorderStyle(.init(color: .clear, width: 0))
            .overlayPreferenceValue(RowCellBounds.self) { rows in
                GeometryReader { proxy in
                    ZStack(alignment: .topLeading) {
                        ForEach(rows.keys.filter { $0 == 0 || $0 < rows.count - 1 }, id: \.self) { row in
                            if let bottom = rows[row]?.map({ proxy[$0].maxY }).max() {
                                Rectangle()
                                    .fill(row == 0 ? headerRule : rowRule)
                                    .frame(width: proxy.size.width, height: 1)
                                    .offset(y: bottom - 0.5)
                            }
                        }
                    }
                }
            }
    }

    private static let rowRule = Color(.separator).opacity(0.4)
    private static let headerRule = Color(.separator).opacity(0.75)

    /// Each cell reports its bounds under its row, so a row's rule sits under its tallest cell.
    struct RowCellBounds: PreferenceKey {
        static let defaultValue: [Int: [Anchor<CGRect>]] = [:]
        static func reduce(value: inout [Int: [Anchor<CGRect>]], nextValue: () -> [Int: [Anchor<CGRect>]]) {
            value.merge(nextValue(), uniquingKeysWith: +)
        }
    }
}
