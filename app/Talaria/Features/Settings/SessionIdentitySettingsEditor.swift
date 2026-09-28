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
            HStack(spacing: 12) {
                Text(previewInitials)
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(previewForeground)
                    .frame(width: avatarPreviewSize, height: avatarPreviewSize)
                    .background(previewColor, in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 1))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Sessions Avatar")
                        .font(AppFont.subheadline(weight: .medium))

                    Text("Stored on this device only.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            SettingsTextFieldRow(title: String(localized: "Display Name"), text: $displayName, placeholder: NSFullUserName())

            SettingsDivider()

            SettingsTextFieldRow(title: String(localized: "Initials"), text: $initials, placeholder: previewInitials)
        }
    }
}
