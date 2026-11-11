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
        SettingsItemRow(title: name, subtitle: account.urlString, accessorySystemImage: "chevron.forward") {
            ServerAvatarBadge(initials: previewInitials, colorHex: account.headerLogoColorHex)
        } badges: {
            if isActive { SettingsStatusPill(label: String(localized: "Active")) }
        }
        .accessibilityLabel(isActive ? String(localized: "\(name), \(account.urlString), active server") : String(localized: "\(name), \(account.urlString)"))
        .accessibilityHint("Opens server details to switch, edit, or remove.")
    }
}
