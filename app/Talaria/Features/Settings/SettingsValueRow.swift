import SwiftUI
import TalariaKit

struct SettingsValueRow<Trailing: View, Supplementary: View>: View {
    let title: String
    var systemImage: String? = nil
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let supplementary: Supplementary

    init(title: String, systemImage: String? = nil,
         @ViewBuilder trailing: () -> Trailing,
         @ViewBuilder supplementary: () -> Supplementary = { EmptyView() }) {
        self.title = title
        self.systemImage = systemImage
        self.trailing = trailing()
        self.supplementary = supplementary()
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            valueRow
            supplementary
        }
        .font(AppFont.subheadline())
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

    private var titleText: some View {
        Group {
            if let systemImage {
                SettingsRowLabel(title: title, systemImage: systemImage)
            } else {
                Text(title).foregroundStyle(.primary)
            }
        }
    }
}
