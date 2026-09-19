import SwiftUI

struct CronJobMetadataRow: View {
    let title: String
    let value: String

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) {
                    titleText
                    valueText
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    titleText
                        .frame(width: 64, alignment: .leading)
                    valueText
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var titleText: some View {
        Text(title)
            .foregroundStyle(.secondary)
    }

    private var valueText: some View {
        Text(value)
            .foregroundStyle(.primary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 2)
    }
}
