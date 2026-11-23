import SwiftUI
import TalariaKit

/// A chat figure's details: a headline over label and value rows on glass. The context ring and a reply's token usage
/// (TAL-1077) open it.
struct ChatFiguresPopover: View {
    let title: String
    let rows: [(label: String, value: String)]
    private let popoverCornerRadius: CGFloat = 18

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline)
                .fontWeight(.semibold)

            Divider()

            ForEach(rows, id: \.label) { row in
                ContextWindowInfoRow(label: row.label, value: row.value)
            }
        }
        .padding()
        .frame(width: 220)
        .adaptiveGlass(
            .regular,
            fallbackMaterial: .regularMaterial,
            in: RoundedRectangle(cornerRadius: popoverCornerRadius, style: .continuous)
        )
        .clipShape(RoundedRectangle(cornerRadius: popoverCornerRadius, style: .continuous))
    }
}

struct ContextWindowPopover: View {
    @Environment(\.locale) private var locale
    let snapshot: ContextWindowSnapshot

    var body: some View {
        ChatFiguresPopover(title: ContextWindowFormatter.tokensLabel(from: snapshot), rows: [
            (String(localized: "Input"), ContextWindowFormatter.inputTokensLabel(from: snapshot)),
            (String(localized: "Output"), ContextWindowFormatter.outputTokensLabel(from: snapshot)),
            (String(localized: "Threshold"), ContextWindowFormatter.thresholdLabel(from: snapshot)),
            (String(localized: "Cost"), ContextWindowFormatter.costLabel(from: snapshot, locale: locale)),
        ])
    }
}
