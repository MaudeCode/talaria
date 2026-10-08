import SwiftUI
import TalariaKit
import UIKit
import UniformTypeIdentifiers

struct ComposerTextInputView: View {
    @Binding var text: String
    let revision: Int
    @Binding var isFocused: Bool
    @Binding var inputHeight: CGFloat
    @Binding var measuredHeight: CGFloat

    let isDisabled: Bool
    let isKeyboardSendEnabled: Bool
    let keyboardSendKey: ComposerSendKey
    let alternateSendBehavior: StreamingSendBehavior
    let verticalPadding: CGFloat
    let onKeyboardSend: (StreamingSendBehavior?) -> Void
    let onPasteFileProviders: ([NSItemProvider]) -> Void
    let onPasteFileURLs: ([URL]) -> Void
    let onPasteImageProviders: ([NSItemProvider]) -> Void
    let onPasteImages: ([UIImage]) -> Void

    var placeholder: LocalizedStringKey = "Ask anything... /commands"

    var body: some View {
        ZStack(alignment: .topLeading) {
            ComposerTextView(
                text: $text,
                revision: revision,
                isFocused: $isFocused,
                isDisabled: isDisabled,
                isKeyboardSendEnabled: isKeyboardSendEnabled,
                keyboardSendKey: keyboardSendKey,
                alternateSendBehavior: alternateSendBehavior,
                onKeyboardSend: onKeyboardSend,
                onHeightChange: updateMeasuredHeight,
                onPasteFileProviders: onPasteFileProviders,
                onPasteFileURLs: onPasteFileURLs,
                onPasteImageProviders: onPasteImageProviders,
                onPasteImages: onPasteImages
            )
            .frame(height: inputHeight)
            .padding(.vertical, verticalPadding)
            .padding(.horizontal, 16)

            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(Color(.placeholderText))
                    .padding(.horizontal, 16)
                    .padding(.vertical, verticalPadding)
                    .allowsHitTesting(false)
            }
        }
        .frame(minHeight: 42, alignment: .topLeading)
    }

    private func updateMeasuredHeight(_ newHeight: CGFloat) {
        guard inputHeight != newHeight || measuredHeight != newHeight else { return }

        DispatchQueue.main.async {
            guard inputHeight != newHeight || measuredHeight != newHeight else { return }
            inputHeight = newHeight
            measuredHeight = newHeight
        }
    }
}

/// The composer's hardware-keyboard commands, all on Return: the "Send With" key sends, the other of
/// Return and ⌘Return inserts a newline, and Ctrl+Return sends the other way while a reply runs (TAL-660).
/// Shift+Return and Option+Return match no command, so the text view inserts their newline itself.
struct ComposerKeyboardCommand: Equatable {
    enum Action: Equatable {
        case send
        case alternateSend
        case newline
    }

    static let input = "\r"
    static let alternateSendModifierFlags: UIKeyModifierFlags = .control

    let action: Action
    let modifierFlags: UIKeyModifierFlags
    let title: String

    static func commands(
        sendKey: ComposerSendKey,
        alternateBehavior: StreamingSendBehavior
    ) -> [ComposerKeyboardCommand] {
        let send = ComposerKeyboardCommand(
            action: .send,
            modifierFlags: sendKey == .return ? [] : .command,
            title: String(localized: "Send Message")
        )
        let alternateSend = ComposerKeyboardCommand(
            action: .alternateSend,
            modifierFlags: alternateSendModifierFlags,
            title: alternateBehavior == .queue ? String(localized: "Queue Message") : String(localized: "Send Now")
        )
        guard sendKey == .return else { return [send, alternateSend] }
        // Plain Return already inserts a newline in ⌘Return mode, so only Return mode needs this one.
        let newline = ComposerKeyboardCommand(action: .newline, modifierFlags: .command, title: String(localized: "New Line"))
        return [send, newline, alternateSend]
    }
}
