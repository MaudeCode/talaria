import SwiftUI
import TalariaKit

struct SettingsValueRow<Trailing: View, Supplementary: View>: View {
    let title: String
    var systemImage: String? = nil
    let hasInteractiveTrailingContent: Bool
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let supplementary: Supplementary

    init(title: String, systemImage: String? = nil, hasInteractiveTrailingContent: Bool = false,
         @ViewBuilder trailing: () -> Trailing,
         @ViewBuilder supplementary: () -> Supplementary = { EmptyView() }) {
        self.title = title
        self.systemImage = systemImage
        self.hasInteractiveTrailingContent = hasInteractiveTrailingContent
        self.trailing = trailing()
        self.supplementary = supplementary()
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let row = VStack(alignment: .leading, spacing: 12) {
            valueRow
            supplementary
        }
        .font(AppFont.subheadline())
        if hasInteractiveTrailingContent {
            row
        } else {
            row.indexedSettingsRow(title: title)
        }
    }

    private var valueRow: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    titleText

                    trailing
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack(spacing: 12) {
                    titleText

                    Spacer(minLength: 16)

                    trailing
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }

    @ViewBuilder
    private var titleText: some View {
        let label = Group {
            if let systemImage {
                SettingsRowLabel(title: title, systemImage: systemImage)
            } else {
                Text(title).foregroundStyle(.primary)
            }
        }
        if hasInteractiveTrailingContent {
            // An identifier on the entire row would also label its separate trailing control.
            label.accessibilityElement(children: .combine)
                .indexedSettingsRow(title: title)
        } else {
            label
        }
    }
}
