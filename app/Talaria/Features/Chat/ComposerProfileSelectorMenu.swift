import SwiftUI
import UIKit
import TalariaKit

struct ComposerProfileSelectorMenu: View {
    let profileOptions: [ProfileSummary]
    let selectedProfileName: String?
    let selectedProfileTitle: String
    let isDisabled: Bool
    let lineLimit: Int
    let verticalPadding: CGFloat
    let horizontalPadding: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font
    let onSelectProfile: (ProfileSummary) -> Void

    var body: some View {
        Menu {
            if profileOptions.isEmpty {
                Text("No profiles available")
            } else {
                Section("Profile") {
                    ForEach(profileOptions, id: \.self) { profile in
                        Button {
                            onSelectProfile(profile)
                        } label: {
                            if profile.name == selectedProfileName {
                                Label(profile.displayName, systemImage: "checkmark")
                            } else {
                                Text(profile.displayName)
                            }
                        }
                    }
                }
            }
        } label: {
            ComposerSecondaryBarLabel(
                title: selectedProfileTitle,
                systemImage: "person.crop.circle",
                lineLimit: lineLimit,
                verticalPadding: verticalPadding,
                horizontalPadding: horizontalPadding,
                color: color,
                controlFont: controlFont,
                chevronFont: chevronFont
            )
        }
        .buttonStyle(.chatTactile(.capsule))
        .tint(color)
        .disabled(isDisabled)
        .accessibilityLabel("Choose profile")
    }
}
