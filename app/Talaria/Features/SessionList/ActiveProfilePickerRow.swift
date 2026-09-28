import SwiftUI
import TalariaKit

struct ActiveProfilePickerRow: View {
    let profile: ProfileSummary
    let isSelected: Bool
    let isSwitching: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 18) {
                SidebarUtilityIcon(
                    assetImage: "LucideUserRound",
                    tint: isSelected ? Color.accentColor : .primary
                )

                VStack(alignment: .leading, spacing: 3) {
                    Text(profile.displayName)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(defaultModelTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if isSwitching {
                    ProgressView()
                        .controlSize(.small)
                } else if isSelected {
                    SidebarSelectedSubrowIndicator()
                }
            }
            .frame(minHeight: 44)
            .sidebarSubrowSelectionStyle(isSelected: isSelected)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }

    private var defaultModelTitle: String {
        let model = profile.model?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let model, !model.isEmpty else {
            return String(localized: "Default model unavailable")
        }
        return model
    }

    private var accessibilityLabel: String {
        let state = isSelected ? String(localized: "Active profile") : String(localized: "Profile")
        let switchingState = isSwitching ? String(localized: ", switching in progress") : ""
        return String(localized: "\(state), \(profile.displayName), \(defaultModelTitle)\(switchingState)")
    }
}
