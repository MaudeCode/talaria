import TalariaKit

typealias ChatHapticFeedback = AppHapticFeedback

@MainActor
enum ChatHaptics {
    typealias Performer = @MainActor (ChatHapticFeedback) -> Void

    static func messageSent(isEnabled: Bool, performer: Performer? = nil) {
        emit(.lightImpact, isEnabled: isEnabled, performer: performer)
    }

    static func assistantResponseCompleted(isEnabled: Bool, performer: Performer? = nil) {
        emit(.success, isEnabled: isEnabled, performer: performer)
    }

    static func streamCancelled(isEnabled: Bool, performer: Performer? = nil) {
        emit(.mediumImpact, isEnabled: isEnabled, performer: performer)
    }

    static func approvalSubmitted(_ choice: ApprovalChoice, isEnabled: Bool, performer: Performer? = nil) {
        switch choice {
        case .once, .session, .always:
            emit(.lightImpact, isEnabled: isEnabled, performer: performer)
        case .deny:
            emit(.warning, isEnabled: isEnabled, performer: performer)
        }
    }

    static func approvalBypassEnabled(isEnabled: Bool, performer: Performer? = nil) {
        emit(.warning, isEnabled: isEnabled, performer: performer)
    }

    static func clarificationSubmitted(isEnabled: Bool, performer: Performer? = nil) {
        emit(.selection, isEnabled: isEnabled, performer: performer)
    }

    static func configurationSelected(isEnabled: Bool, performer: Performer? = nil) {
        emit(.selection, isEnabled: isEnabled, performer: performer)
    }

    static func destructiveConfirmationAccepted(isEnabled: Bool, performer: Performer? = nil) {
        emit(.warning, isEnabled: isEnabled, performer: performer)
    }

    private static func emit(_ feedback: ChatHapticFeedback, isEnabled: Bool, performer: Performer?) {
        HapticEmitter.emit(feedback, isEnabled: isEnabled, performer: performer)
    }
}
