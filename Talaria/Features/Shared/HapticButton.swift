import SwiftUI
import UIKit

enum HapticButtonFeedbackStyle: Equatable {
    case light
    case medium
}

@MainActor
enum HapticEmitter {
    static func emit<Feedback>(
        _ feedback: Feedback,
        isEnabled: Bool,
        performer: (@MainActor (Feedback) -> Void)?,
        defaultPerformer: @escaping @MainActor (Feedback) -> Void
    ) {
        guard isEnabled else { return }
        (performer ?? defaultPerformer)(feedback)
    }
}

@MainActor
enum HapticButtonHaptics {
    typealias Performer = @MainActor (HapticButtonFeedbackStyle) -> Void

    static func tap(
        style: HapticButtonFeedbackStyle = .light,
        isEnabled: Bool,
        performer: Performer? = nil
    ) {
        HapticEmitter.emit(
            style,
            isEnabled: isEnabled,
            performer: performer,
            defaultPerformer: perform
        )
    }

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
