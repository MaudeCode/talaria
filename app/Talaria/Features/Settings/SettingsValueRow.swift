import SwiftUI
import TalariaKit

struct SettingsValueRow<Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: Trailing

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
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
        .font(AppFont.subheadline())
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }

    private var titleText: some View {
        Text(title)
            .foregroundStyle(.primary)
    }
}
