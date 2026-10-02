import SwiftUI

struct SidebarDisclosureButton<Accessory: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let title: String
    var assetImage: String? = nil
    var systemImage: String? = nil
    let isExpanded: Bool
    var tint: Color = .primary
    let action: () -> Void
    @ViewBuilder let accessory: () -> Accessory

    var body: some View {
        HapticButton(action: action) {
            HStack(alignment: .center, spacing: 12) {
                if let assetImage {
                    SidebarUtilityIcon(assetImage: assetImage, tint: tint)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.body)
                        .foregroundStyle(tint)
                        .frame(width: 28)
                        .accessibilityHidden(true)
                }

                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                accessory()

                SidebarDisclosureChevron(isExpanded: isExpanded)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
