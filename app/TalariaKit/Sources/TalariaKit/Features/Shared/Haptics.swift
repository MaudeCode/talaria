import Foundation

public enum HapticButtonFeedbackStyle: Equatable {
    case light
    case medium
}

public enum AppHapticFeedback: Equatable {
    case lightImpact
    case mediumImpact
    case selection
    case success
    case warning
}

@MainActor
public enum HapticEmitter {
    /// Plays feedback on the device. The App installs its UIKit feedback generators at launch; unset, nothing plays.
    public static var perform: @MainActor (AppHapticFeedback) -> Void = { _ in }

    public static func emit(
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
}

@MainActor
public enum HapticButtonHaptics {
    public typealias Performer = @MainActor (HapticButtonFeedbackStyle) -> Void

    /// Plays a button tap on the device; installed by the App at launch like `HapticEmitter.perform`.
    public static var perform: Performer = { _ in }

    public static func tap(
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
}
