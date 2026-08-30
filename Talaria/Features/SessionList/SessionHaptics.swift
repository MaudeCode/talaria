typealias SessionHapticFeedback = AppHapticFeedback

@MainActor
enum SessionHaptics {
    typealias Performer = @MainActor (SessionHapticFeedback) -> Void

    static func sessionCreated(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    static func pinStateChanged(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    static func archiveStateChanged(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    static func sessionDeleted(isEnabled: Bool, performer: Performer? = nil) {
        emit(.warning, isEnabled: isEnabled, performer: performer)
    }

    static func sessionRenamed(isEnabled: Bool, performer: Performer? = nil) {
        emit(.selection, isEnabled: isEnabled, performer: performer)
    }

    private static func emit(_ feedback: SessionHapticFeedback, isEnabled: Bool, performer: Performer?) {
        HapticEmitter.emit(feedback, isEnabled: isEnabled, performer: performer)
    }
}
