import SwiftUI
import TalariaKit

struct SettingsCard<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @ScaledMetric(relativeTo: .body) private var contentSpacing: CGFloat = 12

    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)

        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .textCase(.uppercase)
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.bottom, 8)

            VStack(alignment: .leading, spacing: contentSpacing) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                shape.fill(Color(.secondarySystemBackground).opacity(cardFillOpacity))
            }
            .adaptiveGlass(
                .regular,
                fallbackMaterial: .regularMaterial,
                in: shape
            )
            .overlay {
                shape
                    .stroke(Color.primary.opacity(cardStrokeOpacity), lineWidth: 0.7)
                    .allowsHitTesting(false)
            }
        }
    }

    private var cardFillOpacity: Double {
        reduceTransparency ? 1 : 0.34
    }

    private var cardStrokeOpacity: Double {
        colorSchemeContrast == .increased ? 0.16 : 0.06
    }
}
