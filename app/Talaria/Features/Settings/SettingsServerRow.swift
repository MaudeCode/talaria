import SwiftUI
import TalariaKit

struct SettingsServerRow: View {
    let account: ServerAccount
    let isActive: Bool

    private var hostFallback: String {
        URL(string: account.urlString)?.host ?? account.urlString
    }

    private var name: String {
        account.displayName.isEmpty ? hostFallback : account.displayName
    }

    private var previewInitials: String {
        SessionIdentitySettings.displayInitials(
            displayName: account.displayName,
            storedInitials: account.initials,
            fallbackFullName: hostFallback
        )
    }

    var body: some View {
        HStack(spacing: 12) {
            ServerAvatarBadge(initials: previewInitials, colorHex: account.headerLogoColorHex)

            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(AppFont.subheadline(weight: .medium))
                    .lineLimit(1)

                Text(account.urlString)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            if isActive {
                SettingsStatusPill(label: String(localized: "Active"))
            }

            Image(systemName: "chevron.forward")
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isActive ? String(localized: "\(name), \(account.urlString), active server") : String(localized: "\(name), \(account.urlString)"))
        .accessibilityHint("Opens server details to switch, edit, or remove.")
    }
}
