import SwiftUI
import TalariaKit

struct SettingsRowLabel: View {
    let title: String
    let systemImage: String?
    var status: String? = nil
    @ScaledMetric(relativeTo: .subheadline) private var iconWidth: CGFloat = 24

    var body: some View {
        HStack(spacing: 10) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(AppFont.subheadline(weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: iconWidth)
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(AppFont.subheadline(weight: .medium))
                    .foregroundStyle(.primary)
                if let status {
                    Text(status)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}
