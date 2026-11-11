import SwiftUI
import TalariaKit

struct SettingsRowLabel: View {
    let title: String
    let systemImage: String
    @ScaledMetric(relativeTo: .subheadline) private var iconWidth: CGFloat = 24

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(AppFont.subheadline(weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: iconWidth)
                .accessibilityHidden(true)

            Text(title)
                .font(AppFont.subheadline(weight: .medium))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
