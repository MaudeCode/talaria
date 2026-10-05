import SwiftUI
import UIKit
import TalariaKit

struct ComposerProfileSelectorMenu: View {
    let profileOptions: [ProfileSummary]
    let selectedProfileName: String?
    let selectedProfileTitle: String
    let isDisabled: Bool
    let color: Color
    let controlFont: Font
    let chevronFont: Font
    let onSelectProfile: (ProfileSummary) -> Void

    var body: some View {
        // A UIKit menu, like model and reasoning: a SwiftUI `Menu` ignores the 44 pt hit shape (TAL-629).
        ChatUIKitMenuButton(horizontalPadding: 0, verticalPadding: 14) {
            ComposerMetaControlLabel(
                title: selectedProfileTitle,
                systemImage: "person.crop.circle",
                maxWidth: ComposerControlStrip.titleMaxWidth,
                color: color,
                controlFont: controlFont,
                chevronFont: chevronFont
            )
        } menu: {
            profileMenu()
        }
        .tint(color)
        .disabled(isDisabled)
        .accessibilityLabel("Choose profile")
        .accessibilityValue(selectedProfileTitle)
    }

    private func profileMenu() -> UIMenu {
        guard !profileOptions.isEmpty else {
            let empty = UIAction(title: String(localized: "No profiles available")) { _ in }
            empty.attributes.insert(.disabled)
            return UIMenu(children: [empty])
        }

        return UIMenu(
            title: String(localized: "Profile"),
            options: [.displayInline],
            children: profileOptions.map { profile in
                UIAction(
                    title: profile.displayName,
                    state: profile.name == selectedProfileName ? .on : .off
                ) { _ in
                    Task { @MainActor in
                        onSelectProfile(profile)
                    }
                }
            }
        )
    }
}
