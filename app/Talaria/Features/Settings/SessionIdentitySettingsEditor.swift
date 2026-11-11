import SwiftUI
import TalariaKit

struct SessionIdentitySettingsEditor: View {
    @ScaledMetric(relativeTo: .caption) private var avatarPreviewSize: CGFloat = 36

    @Binding var displayName: String
    @Binding var initials: String
    let previewInitials: String
    let previewColor: Color
    let previewForeground: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsItemRow(title: String(localized: "Sessions Avatar"), subtitle: String(localized: "Stored on this device only.")) {
                Text(previewInitials)
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(previewForeground)
                    .frame(width: avatarPreviewSize, height: avatarPreviewSize)
                    .background(previewColor, in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 1))
                    .accessibilityHidden(true)
            }

            SettingsTextFieldRow(title: String(localized: "Display Name"), text: $displayName, placeholder: NSFullUserName())

            SettingsTextFieldRow(title: String(localized: "Initials"), text: $initials, placeholder: previewInitials)
        }
    }
}
