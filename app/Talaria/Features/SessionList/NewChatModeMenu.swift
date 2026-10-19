import SwiftUI
import TalariaKit

/// TAL-1045: a New Chat control's long press starts a chat in a diagnostic mode. Each mode is the server's; one it
/// cannot start now stays listed, disabled, with its reason. A server that offers none (an older one) shows no menu.
private struct NewChatModeMenu: ViewModifier {
    let modes: [ExecutionModeOption]
    let isDisabled: Bool
    let onSelect: (ExecutionMode) -> Void

    func body(content: Content) -> some View {
        if modes.isEmpty || isDisabled {
            content
        } else {
            content.contextMenu {
                Section("Agent Mode") {
                    ForEach(modes) { option in
                        Button {
                            onSelect(option.mode)
                        } label: {
                            Text(option.mode.title)
                            if let reason = option.reasonTitle {
                                Text(reason)
                            }
                        }
                        .disabled(!option.available)
                    }
                }
            }
        }
    }
}

extension View {
    func newChatModeMenu(_ modes: [ExecutionModeOption], isDisabled: Bool, onSelect: @escaping (ExecutionMode) -> Void) -> some View {
        modifier(NewChatModeMenu(modes: modes, isDisabled: isDisabled, onSelect: onSelect))
    }
}
