import SwiftUI
import TalariaKit

struct ServerIdentityEditor: View {
    @Binding var displayName: String
    @Binding var initials: String
    @Binding var colorHex: String
    /// Host-derived fallback used for the avatar preview when fields are empty.
    let fallbackName: String

    private var previewInitials: String {
        SessionIdentitySettings.displayInitials(
            displayName: displayName.isEmpty ? fallbackName : displayName,
            storedInitials: initials,
            fallbackFullName: fallbackName
        )
    }

    private var initialsBinding: Binding<String> {
        Binding(
            get: { initials },
            set: { initials = SessionIdentitySettings.normalizedInitials($0) }
        )
    }

    private var colorBinding: Binding<Color> {
        HeaderLogoColor.binding($colorHex)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ServerAvatarBadge(initials: previewInitials, colorHex: colorHex, size: 36)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Server Avatar")
                        .font(AppFont.subheadline(weight: .medium))

                    Text("Stored on this device only.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            SettingsTextFieldRow(
                title: String(localized: "Display Name"),
                text: $displayName,
                placeholder: fallbackName.isEmpty ? String(localized: "Server") : fallbackName
            )

            SettingsDivider()

            SettingsTextFieldRow(title: String(localized: "Initials"), text: initialsBinding, placeholder: previewInitials)

            SettingsDivider()

            AccentColorSettings(selectedHex: $colorHex, customColor: colorBinding)
        }
    }
}

/// Why the last identity save failed, with a retry; the edit stays staged until
/// a save lands (TAL-123).
struct IdentitySaveErrorNotice: View {
    let authManager: AuthManager

    var body: some View {
        if let message = authManager.identitySaveErrorMessage {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(AppFont.footnote())
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)

            SettingsButton(String(localized: "Retry")) {
                authManager.flushServerIdentityEdits()
            }
        }
    }
}
