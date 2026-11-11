import SwiftUI
import TalariaKit

/// The item sibling of SettingsAccessoryRow, with a subtitle and custom leading content.
struct SettingsItemRow<Leading: View, Badges: View, Accessory: View>: View {
    let title: String
    var subtitle: String?
    var detail: String?
    var accessibilityIdentifier: String?
    var containsActions = false
    var isSelected = false
    var isLoading = false
    var accessorySystemImage: String? = nil
    @ViewBuilder var leading: Leading
    @ViewBuilder var badges: Badges
    @ViewBuilder var accessory: Accessory
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(title: String, subtitle: String? = nil, detail: String? = nil, accessibilityIdentifier: String? = nil,
         containsActions: Bool = false, isSelected: Bool = false, isLoading: Bool = false,
         accessorySystemImage: String? = nil,
         @ViewBuilder leading: () -> Leading = { EmptyView() },
         @ViewBuilder badges: () -> Badges = { EmptyView() },
         @ViewBuilder accessory: () -> Accessory = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.detail = detail
        self.accessibilityIdentifier = accessibilityIdentifier
        self.containsActions = containsActions
        self.isSelected = isSelected
        self.isLoading = isLoading
        self.accessorySystemImage = accessorySystemImage
        self.leading = leading()
        self.badges = badges()
        self.accessory = accessory()
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) { leading.foregroundStyle(.secondary); itemText }
                    HStack(spacing: 8) { badges; itemAccessory }
                }
            } else {
                HStack(spacing: 10) {
                    leading.foregroundStyle(.secondary)
                    itemText
                    badges
                    itemAccessory
                }
            }
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: containsActions ? .contain : .combine)
        .accessibilityIdentifier(accessibilityIdentifier ?? "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var itemAccessory: some View {
        Group {
            if isLoading {
                ProgressView().controlSize(.small)
            } else if isSelected {
                Image(systemName: "checkmark").foregroundStyle(Color.accentColor).accessibilityHidden(true)
            } else if let accessorySystemImage {
                Image(systemName: accessorySystemImage).foregroundStyle(.tertiary).accessibilityHidden(true)
            }
            accessory
        }
        .font(AppFont.caption(weight: .semibold))
    }

    private var itemText: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(AppFont.subheadline(weight: .medium))
                .foregroundStyle(.primary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            secondaryText(subtitle)
            secondaryText(detail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func secondaryText(_ text: String?) -> some View {
        if let text, !text.isEmpty {
            Text(text)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
    }
}
