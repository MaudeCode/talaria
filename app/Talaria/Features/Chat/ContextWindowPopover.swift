import SwiftUI
import TalariaKit

struct ContextWindowPopover: View {
    let snapshot: ContextWindowSnapshot
    private let popoverCornerRadius: CGFloat = 18

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(ContextWindowFormatter.tokensLabel(from: snapshot))
                .font(.subheadline)
                .fontWeight(.semibold)

            Divider()

            ContextWindowInfoRow(
                label: String(localized: "Input"),
                value: ContextWindowFormatter.inputTokensLabel(from: snapshot)
            )
            ContextWindowInfoRow(
                label: String(localized: "Output"),
                value: ContextWindowFormatter.outputTokensLabel(from: snapshot)
            )
            ContextWindowInfoRow(
                label: String(localized: "Threshold"),
                value: ContextWindowFormatter.thresholdLabel(from: snapshot)
            )
            ContextWindowInfoRow(
                label: String(localized: "Cost"),
                value: ContextWindowFormatter.costLabel(from: snapshot)
            )
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
