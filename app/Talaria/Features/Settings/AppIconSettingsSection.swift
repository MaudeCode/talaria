import SwiftUI
import UIKit
import TalariaKit

struct AppIconSettingsSection: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedAppIcon = AppIconChoice.system
    @State private var updatingAppIcon: AppIconChoice?
    @State private var appIconErrorMessage: String?
    @State private var isAppIconPickerExpanded = false

    var body: some View {
        if UIApplication.shared.supportsAlternateIcons {
            VStack(alignment: .leading, spacing: 12) {
                DisclosureGroup(isExpanded: $isAppIconPickerExpanded) {
                    appIconChoices
                        .padding(.top, 12)
                } label: {
                    AppIconDisclosureLabel(selectedAppIcon: selectedAppIcon)
                }
                .tint(.secondary)

                if let appIconErrorMessage {
                    Text(appIconErrorMessage)
                        .font(AppFont.caption())
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .onAppear {
                refreshSelectedAppIcon()
            }
            .onChange(of: scenePhase) { _, newPhase in
                guard newPhase == .active else { return }
                refreshSelectedAppIcon()
            }
        }
    }

    private var appIconChoices: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(AppIconChoice.allCases.enumerated()), id: \.element.id) { index, icon in
                if index > 0 {
                    appIconDivider
                }

                HapticButton(feedbackStyle: .light) {
                    updateAppIcon(to: icon)
                } label: {
                    AppIconChoiceRow(
                        icon: icon,
                        isSelected: selectedAppIcon == icon,
                        isUpdating: updatingAppIcon == icon
                    )
                }
                .buttonStyle(.plain)
                .disabled(updatingAppIcon != nil)
            }
        }
    }

    private var appIconDivider: some View {
        Divider()
            .padding(.leading, 2)
            .opacity(0.72)
    }

    private func refreshSelectedAppIcon() {
        selectedAppIcon = AppIconChoice.current
    }

    private func updateAppIcon(to appIcon: AppIconChoice) {
        guard selectedAppIcon != appIcon, updatingAppIcon == nil else {
            return
        }

        appIconErrorMessage = nil
        updatingAppIcon = appIcon

        UIApplication.shared.setAlternateIconName(appIcon.alternateIconName) { error in
            Task { @MainActor in
                withAnimation {
                    updatingAppIcon = nil

                    if let error {
                        appIconErrorMessage = error.localizedDescription
                        selectedAppIcon = AppIconChoice.current
                        isAppIconPickerExpanded = true
                    } else {
                        selectedAppIcon = appIcon
                        isAppIconPickerExpanded = false
                    }
                }
            }
        }
    }
}
