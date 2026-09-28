import SwiftUI
import UIKit
import TalariaKit

/// UIKit feedback generators behind TalariaKit's haptic hooks; `PlatformBridges` installs them at launch.
enum UIKitHaptics {
    @MainActor
    static func perform(_ feedback: AppHapticFeedback) {
        switch feedback {
        case .lightImpact:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .mediumImpact:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .selection:
            UISelectionFeedbackGenerator().selectionChanged()
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }

    @MainActor
    static func perform(_ style: HapticButtonFeedbackStyle) {
        switch style {
        case .light:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .medium:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }
}

struct HapticButton<Label: View>: View {
    let feedbackStyle: HapticButtonFeedbackStyle
    let role: ButtonRole?
    let action: () -> Void
    let label: Label

    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    init(
        feedbackStyle: HapticButtonFeedbackStyle = .light,
        role: ButtonRole? = nil,
        action: @escaping () -> Void,
        @ViewBuilder label: () -> Label
    ) {
        self.feedbackStyle = feedbackStyle
        self.role = role
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(role: role) {
            HapticButtonHaptics.tap(
                style: feedbackStyle,
                isEnabled: isHapticsEnabled
            )
            action()
        } label: {
            label
        }
    }
}
