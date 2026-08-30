import SwiftUI
import UIKit

struct SelectableTextPresentation: Identifiable, Equatable {
    let id: String
    let text: String

    init(id: String, text: String) {
        self.id = id
        self.text = text
    }

    init(context: MessageActionContext) {
        self.init(id: context.messageID, text: context.copyText)
    }
}

struct ChatMessageActionMenu: View {
    let context: MessageActionContext
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    let hasActiveStream: Bool
    let isRegeneratingMessage: Bool
    let isEditingMessage: Bool
    let isForkingMessage: Bool
    let disablesHistoryActions: Bool
    let onToggleListening: (MessageActionContext) -> Void
    let onSelectText: (MessageActionContext) -> Void
    let onRegenerate: (MessageActionContext) -> Void
    let onEdit: (MessageActionContext) -> Void
    let onFork: (MessageActionContext) -> Void
    let onCopy: (MessageActionContext) -> Void

    var body: some View {
        if context.role == .assistant {
            Button {
                onToggleListening(context)
            } label: {
                Label(
                    isListening ? "Stop Listening" : "Listen",
                    systemImage: isListening ? "speaker.slash" : "speaker.wave.2"
                )
            }

            Button {
                onSelectText(context)
            } label: {
                Label("Select Text", systemImage: "text.cursor")
            }

            Button {
                onRegenerate(context)
            } label: {
                Label("Regenerate Response", systemImage: "arrow.clockwise")
            }
            .disabled(disablesHistoryActions || isViewingCachedData || hasActiveStream || isRegeneratingMessage)
        }

        if context.role == .user {
            Button {
                onEdit(context)
            } label: {
                Label("Edit Message", systemImage: "pencil")
            }
            .disabled(disablesHistoryActions || isViewingCachedData || hasActiveStream || isEditingMessage)
        }

        Button {
            onFork(context)
        } label: {
            Label("Fork From Here", systemImage: "arrow.triangle.branch")
        }
        .disabled(disablesHistoryActions || isViewingCachedData || hasActiveStream || isForkingMessage)

        Button {
            onCopy(context)
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
    }

    private var isListening: Bool {
        listeningMessageID == context.messageID
    }
}
