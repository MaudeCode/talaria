import SwiftUI
import UIKit

enum HapticButtonFeedbackStyle: Equatable {
    case light
    case medium
}

enum AppHapticFeedback: Equatable {
    case lightImpact
    case mediumImpact
    case selection
    case success
    case warning
}

@MainActor
enum HapticEmitter {
    static func emit(
        _ feedback: AppHapticFeedback,
        isEnabled: Bool,
        performer: (@MainActor (AppHapticFeedback) -> Void)? = nil
    ) {
        emit(feedback, isEnabled: isEnabled, performer: performer, defaultPerformer: perform)
    }

    static func emit<Feedback>(
        _ feedback: Feedback,
        isEnabled: Bool,
        performer: (@MainActor (Feedback) -> Void)?,
        defaultPerformer: @escaping @MainActor (Feedback) -> Void
    ) {
        guard isEnabled else { return }
        (performer ?? defaultPerformer)(feedback)
    }

    private static func perform(_ feedback: AppHapticFeedback) {
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
