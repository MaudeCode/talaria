import SwiftUI
import TalariaKit

struct SettingsAccessoryRow: View {
    let title: String
    var value: String?
    let systemImage: String
    var accessorySystemImage = "chevron.forward"

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize, let value {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        leadingLabel
                        Spacer(minLength: 8)
                        accessoryIcon
                    }

                    Text(value)
                        .font(AppFont.caption(weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                        .padding(.leading, 34)
                }
            } else {
                HStack(alignment: .center, spacing: 10) {
                    leadingLabel

                    Spacer(minLength: 8)

                    if let value {
                        Text(value)
                            .font(AppFont.caption(weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .multilineTextAlignment(.trailing)
                    }

                    accessoryIcon
                }
            }
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var leadingLabel: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(AppFont.subheadline(weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(title)
                .font(AppFont.subheadline(weight: .medium))
                .layoutPriority(1)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var accessoryIcon: some View {
        Image(systemName: accessorySystemImage)
            .font(AppFont.caption(weight: .semibold))
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}
