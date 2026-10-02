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
            .settingsGroupedCell()
        }
    }
}

extension View {
    /// The Settings root's inset-grouped cell fill and corner radius, so every Settings page
    /// reads as the same list. Pages showing these cells use `systemGroupedBackground`.
    func settingsGroupedCell() -> some View {
        background(
            Color(.secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: settingsGroupedCellCornerRadius, style: .continuous)
        )
    }
}

private var settingsGroupedCellCornerRadius: CGFloat {
    if #available(iOS 26, *) { 26 } else { 10 }
}
