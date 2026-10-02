import SwiftUI
import TalariaKit

struct SettingsCard<Content: View>: View {
    @ScaledMetric(relativeTo: .body) private var contentSpacing: CGFloat = 12

    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
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
            .background(
                Color(.secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: Self.groupedCellCornerRadius, style: .continuous)
            )
        }
    }

    /// The Settings root's inset-grouped cell radius, so category pages read as the same list.
    private static var groupedCellCornerRadius: CGFloat {
        if #available(iOS 26, *) { 26 } else { 10 }
    }
}
