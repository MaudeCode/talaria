import SwiftUI

/// One message action, defined once and rendered by every surface that offers
/// it: the long-press menu and VoiceOver's custom actions (TAL-49). A surface
/// renders the list; it never decides which actions a message has.
struct ChatMessageAction: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    let isEnabled: Bool
    let handler: () -> Void
}

/// The transcript state the action list depends on. Grouped so the catalog has
/// one parameter per concern instead of a seven-argument call at every surface.
struct ChatMessageActionState: Equatable {
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

struct ChatMessageActionHandlers {
    let onToggleListening: (MessageActionContext) -> Void
    let onSelectText: (MessageActionContext) -> Void
    let onRegenerate: (MessageActionContext) -> Void
    let onEdit: (MessageActionContext) -> Void
    let onFork: (MessageActionContext) -> Void
    let onCopy: (MessageActionContext) -> Void
}

enum ChatMessageActionCatalog {
    static func actions(
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
