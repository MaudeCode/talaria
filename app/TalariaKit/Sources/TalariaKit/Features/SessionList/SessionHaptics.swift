public typealias SessionHapticFeedback = AppHapticFeedback

@MainActor
public enum SessionHaptics {
    public typealias Performer = @MainActor (SessionHapticFeedback) -> Void

    public static func sessionCreated(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    public static func pinStateChanged(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    public static func archiveStateChanged(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    public static func sessionDeleted(isEnabled: Bool, performer: Performer? = nil) {
        emit(.warning, isEnabled: isEnabled, performer: performer)
    }

    public static func sessionRenamed(isEnabled: Bool, performer: Performer? = nil) {
        emit(.selection, isEnabled: isEnabled, performer: performer)
    }

    private static func emit(_ feedback: SessionHapticFeedback, isEnabled: Bool, performer: Performer?) {
        HapticEmitter.emit(feedback, isEnabled: isEnabled, performer: performer)
    }
}
