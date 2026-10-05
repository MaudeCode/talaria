import SwiftUI
import UIKit
import TalariaKit

struct ComposerReasoningMenu: View {
    let selectedReasoningEffort: String?
    /// Server-provided effort vocabulary for the current model; `nil` falls
    /// back to the full static list (older servers, issue #18).
    let supportedEfforts: [String]?
    let reasoningTitle: String
    let isDisabled: Bool
    let width: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font
    let onSelectReasoningEffort: (String) -> Void

    var body: some View {
        ChatUIKitMenuButton(horizontalPadding: 0, verticalPadding: 14) {
            ComposerMetaControlLabel(
                title: reasoningTitle,
                systemImage: "lucide.brain",
                minWidth: width,
                maxWidth: width,
                color: color,
                controlFont: controlFont,
                chevronFont: chevronFont
            )
        } menu: {
            makeReasoningMenu()
        }
        .tint(color)
        .disabled(isDisabled)
        .accessibilityLabel("Select reasoning effort")
        .accessibilityValue(reasoningTitle)
    }

    private func makeReasoningMenu() -> UIMenu {
        UIMenu(
            title: String(localized: "Reasoning"),
            options: [.displayInline],
            children: ReasoningEffortOption.options(forSupportedEfforts: supportedEfforts).map { option in
                UIAction(
                    title: option.title,
                    state: selectedReasoningEffort == option.id ? .on : .off
                ) { _ in
                    Task { @MainActor in
                        onSelectReasoningEffort(option.id)
                    }
                }
            }
        )
    }
}
