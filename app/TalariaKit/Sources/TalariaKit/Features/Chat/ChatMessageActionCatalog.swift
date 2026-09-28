import SwiftUI

/// One message action, defined once and rendered by every surface that offers
/// it: the long-press menu and VoiceOver's custom actions (TAL-49). A surface
/// renders the list; it never decides which actions a message has.
public struct ChatMessageAction: Identifiable {
    public let id: String
    public let title: String
    public let systemImage: String
    public let isEnabled: Bool
    public let handler: () -> Void
}

/// The transcript state the action list depends on. Grouped so the catalog has
/// one parameter per concern instead of a seven-argument call at every surface.
public struct ChatMessageActionState: Equatable {
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    /// The server owns this session as view-only (TAL-152). Kept apart from
    /// cached-data state: forking a read-only transcript is still allowed.
    let isSessionReadOnly: Bool
    let hasActiveStream: Bool
    let isRegeneratingMessage: Bool
    let isEditingMessage: Bool
    let isForkingMessage: Bool
    let disablesHistoryActions: Bool
    /// The server's branch gate (TAL-312): it refuses subagents and read-only non-cron sessions.
    var canBranch = true

    public init(listeningMessageID: String?, isViewingCachedData: Bool, isSessionReadOnly: Bool, hasActiveStream: Bool, isRegeneratingMessage: Bool, isEditingMessage: Bool, isForkingMessage: Bool, disablesHistoryActions: Bool, canBranch: Bool = true) {
        self.listeningMessageID = listeningMessageID
        self.isViewingCachedData = isViewingCachedData
        self.isSessionReadOnly = isSessionReadOnly
        self.hasActiveStream = hasActiveStream
        self.isRegeneratingMessage = isRegeneratingMessage
        self.isEditingMessage = isEditingMessage
        self.isForkingMessage = isForkingMessage
        self.disablesHistoryActions = disablesHistoryActions
        self.canBranch = canBranch
    }

    /// True for actions that rewrite history: they need a live, writable
    /// transcript that is not already mid-mutation.
    func allowsHistoryAction(whileBusy isBusy: Bool) -> Bool {
        !disablesHistoryActions && !isViewingCachedData && !hasActiveStream && !isBusy
    }

    /// True for actions that write to this session (edit, regenerate): they
    /// also need the server to treat the session as writable.
    func allowsSessionMutation(whileBusy isBusy: Bool) -> Bool {
        allowsHistoryAction(whileBusy: isBusy) && !isSessionReadOnly
    }
}

public struct ChatMessageActionHandlers {
    let onToggleListening: (MessageActionContext) -> Void
    let onSelectText: (MessageActionContext) -> Void
    let onRegenerate: (MessageActionContext) -> Void
    let onEdit: (MessageActionContext) -> Void
    let onFork: (MessageActionContext) -> Void
    let onCopy: (MessageActionContext) -> Void

    public init(onToggleListening: @escaping (MessageActionContext) -> Void, onSelectText: @escaping (MessageActionContext) -> Void, onRegenerate: @escaping (MessageActionContext) -> Void, onEdit: @escaping (MessageActionContext) -> Void, onFork: @escaping (MessageActionContext) -> Void, onCopy: @escaping (MessageActionContext) -> Void) {
        self.onToggleListening = onToggleListening
        self.onSelectText = onSelectText
        self.onRegenerate = onRegenerate
        self.onEdit = onEdit
        self.onFork = onFork
        self.onCopy = onCopy
    }
}

public enum ChatMessageActionCatalog {
    public static func actions(
        context: MessageActionContext,
        state: ChatMessageActionState,
        handlers: ChatMessageActionHandlers
    ) -> [ChatMessageAction] {
        var actions: [ChatMessageAction] = []

        if context.role == .assistant {
            let isListening = state.listeningMessageID == context.messageID
            actions.append(
                ChatMessageAction(
                    id: "listen",
                    title: isListening
                        ? String(localized: "Stop Listening")
                        : String(localized: "Listen"),
                    systemImage: isListening ? "speaker.slash" : "speaker.wave.2",
                    isEnabled: true,
                    handler: { handlers.onToggleListening(context) }
                )
            )

            actions.append(
                ChatMessageAction(
                    id: "select-text",
                    title: String(localized: "Select Text"),
                    systemImage: "text.cursor",
                    isEnabled: true,
                    handler: { handlers.onSelectText(context) }
                )
            )

            actions.append(
                ChatMessageAction(
                    id: "regenerate",
                    title: String(localized: "Regenerate Response"),
                    systemImage: "arrow.clockwise",
                    isEnabled: state.allowsSessionMutation(whileBusy: state.isRegeneratingMessage),
                    handler: { handlers.onRegenerate(context) }
                )
            )
        }

        if context.role == .user {
            actions.append(
                ChatMessageAction(
                    id: "edit",
                    title: String(localized: "Edit Message"),
                    systemImage: "pencil",
                    isEnabled: state.allowsSessionMutation(whileBusy: state.isEditingMessage),
                    handler: { handlers.onEdit(context) }
                )
            )
        }

        actions.append(
            ChatMessageAction(
                id: "fork",
                title: String(localized: "Fork From Here"),
                systemImage: "arrow.triangle.branch",
                isEnabled: state.allowsHistoryAction(whileBusy: state.isForkingMessage) && state.canBranch,
                handler: { handlers.onFork(context) }
            )
        )

        actions.append(
            ChatMessageAction(
                id: "copy",
                title: String(localized: "Copy"),
                systemImage: "doc.on.doc",
                isEnabled: true,
                handler: { handlers.onCopy(context) }
            )
        )

        return actions
    }
}
