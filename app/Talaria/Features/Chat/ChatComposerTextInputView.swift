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
    /// Caps the text at that height; longer text scrolls inside it.
    var maximumInputHeight: CGFloat = .infinity

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
            .frame(height: min(inputHeight, maximumInputHeight))
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
/// Shift+Return and Option+Return insert a newline too. They are commands, not left to the text view, because the
/// system keyboard's own Return handling can drop the key while it settles an autocorrect candidate (TAL-689).
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
    /// Left out of the keyboard-shortcut list, which shows each action once.
    var isHidden = false

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
        // The other of Return and ⌘Return is the listed newline; Shift and Option add hidden ones.
        let newlineFlags: [UIKeyModifierFlags] = [sendKey == .return ? .command : [], .shift, .alternate]
        let newlines = newlineFlags.enumerated().map { index, flags in
            ComposerKeyboardCommand(
                action: .newline,
                modifierFlags: flags,
                title: String(localized: "New Line"),
                isHidden: index > 0
            )
        }
        return [send] + newlines + [alternateSend]
    }
}

/// The composer card: its text and two control groups, + and the chevron, then voice, context and send. The text
/// sits over a row of the controls, or, in a pane too short for that, between them in one row (TAL-680). Its
/// subviews are the text, the leading group and the trailing group, in that order.
struct ComposerCardLayout: Layout {
    var isOneRow: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width }
        return CGSize(width: width, height: frames(width: width, subviews: subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, frames(width: bounds.width, subviews: subviews).frames) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size)
            )
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> (frames: [CGRect], height: CGFloat) {
        guard subviews.count == 3 else { return ([], 0) }
        let leading = subviews[1].sizeThatFits(.unspecified)
        let trailing = subviews[2].sizeThatFits(.unspecified)
        func frame(x: CGFloat, midY: CGFloat, size: CGSize) -> CGRect {
            CGRect(x: x, y: midY - size.height / 2, width: size.width, height: size.height)
        }
        if isOneRow {
            let textWidth = max(0, width - 10 - leading.width - trailing.width - 16)
            let text = CGSize(width: textWidth, height: subviews[0].sizeThatFits(ProposedViewSize(width: textWidth, height: nil)).height)
            let height = max(text.height, leading.height, trailing.height)
            return ([
                frame(x: 10 + leading.width, midY: height / 2, size: text),
                frame(x: 10, midY: height / 2, size: leading),
                frame(x: width - 16 - trailing.width, midY: height / 2, size: trailing)
            ], height)
        }
        // The controls row: 16 pt in from each side, 2 pt under the text, 8 pt above the card's edge.
        let text = CGSize(width: width, height: subviews[0].sizeThatFits(ProposedViewSize(width: width, height: nil)).height)
        let rowHeight = max(leading.height, trailing.height)
        let rowMidY = text.height + 2 + rowHeight / 2
        return ([
            CGRect(origin: .zero, size: text),
            frame(x: 16, midY: rowMidY, size: leading),
            frame(x: width - 16 - trailing.width, midY: rowMidY, size: trailing)
        ], text.height + 2 + rowHeight + 8)
    }
}
