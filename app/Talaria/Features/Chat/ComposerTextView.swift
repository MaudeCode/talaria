import SwiftUI
import TalariaKit
import UIKit
import UniformTypeIdentifiers

/// The composer's text view while it is on screen, so text dropped on the composer goes in at its caret (TAL-1461).
/// The chat keeps it across a layout replacement, so the next editor takes over focus and selection (TAL-2565).
@MainActor
final class ComposerCaret {
    weak var textView: UITextView?
    /// The editing a replaced editor held: its draft and selected UTF-16 range, for the editor mounted in its place.
    private(set) var handoff: (source: ObjectIdentifier, text: String, selection: NSRange)?

    /// Records the focused editor's text and selection before navigation replaces it; an unfocused one records nothing.
    func captureEditingForReplacement() {
        guard let textView, textView.window != nil, textView.isFirstResponder else {
            handoff = nil
            return
        }
        handoff = (ObjectIdentifier(textView), textView.text, textView.selectedRange)
    }

    func discardHandoff() { handoff = nil }

    /// Gives the replacing editor the handed-over selection once it is focused and shows the same draft.
    func restoreHandoff(in textView: UITextView) {
        guard let handoff, ObjectIdentifier(textView) != handoff.source,
              textView.isFirstResponder, textView.text == handoff.text else { return }
        self.handoff = nil
        textView.selectedRange = handoff.selection
    }

    /// An editor began editing. The replaced one doing so was never replaced, so it hands nothing over.
    func editingDidBegin(in textView: UITextView) {
        if let handoff, ObjectIdentifier(textView) == handoff.source {
            self.handoff = nil
        } else {
            restoreHandoff(in: textView)
        }
    }

    /// An editor other than the replaced one stopped editing: the keyboard was dismissed, so nothing is handed over.
    func editingDidEnd(in textView: UITextView) {
        guard let handoff, ObjectIdentifier(textView) != handoff.source else { return }
        self.handoff = nil
    }

    /// Inserts `text` at the caret, over any selection, through the text view's own input path so the draft follows.
    /// With no text view on screen, as in the one-line shell, it goes at the draft's end.
    func insert(_ text: String, into draft: Binding<String>) {
        if let textView, textView.window != nil, textView.isEditable {
            textView.insertText(text)
        } else {
            draft.wrappedValue += text
        }
    }
}

struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let revision: Int
    @Binding var isFocused: Bool
    let isDisabled: Bool
    let isKeyboardSendEnabled: Bool
    let keyboardSendKey: ComposerSendKey
    let alternateSendBehavior: StreamingSendBehavior
    let onKeyboardSend: (StreamingSendBehavior?) -> Void
    /// The text's height, capped at `maximumHeight`, and its height at one line of the current font.
    let onHeightChange: (_ height: CGFloat, _ oneLineHeight: CGFloat) -> Void
    var maximumHeight: CGFloat = 96
    let onPasteFileProviders: ([NSItemProvider]) -> Void
    let onPasteFileURLs: ([URL]) -> Void
    let onPasteImageProviders: ([NSItemProvider]) -> Void
    let onPasteImages: ([UIImage]) -> Void
    var caret: ComposerCaret?

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, isFocused: $isFocused, onHeightChange: onHeightChange)
    }

    func makeUIView(context: Context) -> PastingTextView {
        let textView = PastingTextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.isScrollEnabled = true
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.textContentType = .none
        textView.pasteConfiguration = UIPasteConfiguration(
            acceptableTypeIdentifiers: [
                UTType.fileURL.identifier,
                UTType.image.identifier,
                UTType.text.identifier
            ]
        )
        // The composer card takes every drop (TAL-1461): the text view's own would put text at the drop point and a
        // file in as its URL.
        if let textDropInteraction = textView.textDropInteraction {
            textView.removeInteraction(textDropInteraction)
        }
        applyInputHandling(to: textView, coordinator: context.coordinator)
        context.coordinator.reportHeight(for: textView)
        return textView
    }

    static func dismantleUIView(_ textView: PastingTextView, coordinator: Coordinator) {
        // A replaced question's field must not clear the new field's focus.
        textView.delegate = nil
    }

    func updateUIView(_ textView: PastingTextView, context: Context) {
        context.coordinator.onHeightChange = onHeightChange
        context.coordinator.maximumHeight = maximumHeight
        context.coordinator.applyBoundText(text, revision: revision, to: textView)
        caret?.restoreHandoff(in: textView)
        // Mirror the chat RTL toggle onto the text view itself (#259): SwiftUI's
        // layoutDirection environment does not propagate into a wrapped UITextView,
        // so set the base direction directly so the cursor/empty-field rests on the
        // trailing edge. `.natural` keeps the LTR default untouched, and per-run
        // bidi still resolves mixed Arabic+Latin/URL content within the line.
        let isRTL = context.environment.layoutDirection == .rightToLeft
        textView.semanticContentAttribute = isRTL ? .forceRightToLeft : .unspecified
        textView.textAlignment = isRTL ? .right : .natural
        textView.applyEditability(!isDisabled)
        applyInputHandling(to: textView, coordinator: context.coordinator)
        context.coordinator.syncFocus(for: textView, shouldFocus: isFocused, isDisabled: isDisabled)
        context.coordinator.reportHeight(for: textView)
    }

    private func applyInputHandling(to textView: PastingTextView, coordinator: Coordinator) {
        caret?.textView = textView
        coordinator.caret = caret
        textView.isKeyboardSendEnabled = isKeyboardSendEnabled
        textView.keyboardSendKey = keyboardSendKey
        textView.alternateSendBehavior = alternateSendBehavior
        textView.onKeyboardSend = onKeyboardSend
        textView.onPasteFileProviders = onPasteFileProviders
        textView.onPasteFileURLs = onPasteFileURLs
        textView.onPasteImageProviders = onPasteImageProviders
        textView.onPasteImages = onPasteImages
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        @Binding var text: String
        @Binding var isFocused: Bool
        var onHeightChange: (_ height: CGFloat, _ oneLineHeight: CGFloat) -> Void
        var caret: ComposerCaret?
        var maximumHeight: CGFloat = 96
        private var pendingFocusTarget: Bool?
        // The newest draft revision this coordinator has acted on. An update carrying
        // an older one has been superseded, so applying it would replay a draft the
        // owner has already moved past.
        private var appliedRevision = Int.min
        // An external replacement that arrived mid-composition. Applying it straight
        // away would drop the marked text, so it waits for the composition to end and
        // is then applied exactly once.
        private var pendingExternalText: String?

        init(
            text: Binding<String>,
            isFocused: Binding<Bool>,
            onHeightChange: @escaping (_ height: CGFloat, _ oneLineHeight: CGFloat) -> Void
        ) {
            _text = text
            _isFocused = isFocused
            self.onHeightChange = onHeightChange
        }

        func applyBoundText(_ boundText: String, revision: Int, to textView: UITextView) {
            guard revision > appliedRevision else { return }
            appliedRevision = revision

            guard textView.text != boundText else {
                pendingExternalText = nil
                return
            }

            // Overwriting the text view during an IME composition drops the marked
            // text, its selection and the keyboard's candidate state, so hold the
            // replacement until the composition ends.
            guard textView.markedTextRange == nil else {
                pendingExternalText = boundText
                return
            }

            pendingExternalText = nil
            textView.text = boundText
        }

        func syncFocus(for textView: UITextView, shouldFocus: Bool, isDisabled: Bool) {
            if isDisabled, isFocused {
                Task { @MainActor [weak self, weak textView] in
                    guard let self, let textView, textView.delegate === self,
                          !textView.isEditable else { return }
                    self.isFocused = false
                }
            }

            let target = shouldFocus && !isDisabled
            guard textView.isFirstResponder != target else {
                pendingFocusTarget = nil
                return
            }
            guard pendingFocusTarget != target else { return }

            pendingFocusTarget = target
            Task { @MainActor [weak self, weak textView] in
                await Task.yield()
                guard let self, let textView else { return }

                if target, textView.window == nil {
                    try? await Task.sleep(nanoseconds: 60_000_000)
                }

                guard textView.delegate === self, self.pendingFocusTarget == target else { return }
                self.pendingFocusTarget = nil

                if target {
                    guard self.isFocused, textView.isEditable, textView.window != nil else { return }
                    textView.becomeFirstResponder()
                } else if !self.isFocused, textView.isFirstResponder {
                    // A tap may have focused the field since this work was queued.
                    textView.resignFirstResponder()
                }
            }
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            // An empty menu presents nothing; nil keeps the system menu.
            (textView as? PastingTextView)?.isOpeningEditMenuFromControlReturn == true ? UIMenu(children: []) : nil
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !isFocused {
                isFocused = true
            }
            caret?.editingDidBegin(in: textView)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            flushPendingExternalText(into: textView)
            caret?.editingDidEnd(in: textView)
            if isFocused {
                isFocused = false
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !flushPendingExternalText(into: textView) else { return }

            // A deferred replacement owns the binding until the composition that
            // blocked it ends. Publishing provisional marked text over it would both
            // discard the replacement and register a spurious user edit.
            guard pendingExternalText == nil else {
                reportHeight(for: textView)
                return
            }

            publish(textView.text, from: textView)
        }

        /// Applies the external replacement that was deferred during a composition,
        /// once that composition has ended. Reports whether the pending value was
        /// consumed. The binding already holds it, so it is not published back.
        @discardableResult
        private func flushPendingExternalText(into textView: UITextView) -> Bool {
            guard textView.markedTextRange == nil, let pending = pendingExternalText else { return false }

            pendingExternalText = nil
            if textView.text != pending {
                textView.text = pending
            }
            reportHeight(for: textView)
            return true
        }

        private func publish(_ value: String, from textView: UITextView) {
            reportHeight(for: textView)

            // Writing an unchanged value still counts as a composer edit for the
            // draft bookkeeping behind the binding, so only publish real changes.
            guard text != value else { return }

            text = value
        }

        func reportHeight(for textView: UITextView) {
            guard textView.bounds.width > 0 else { return }

            // The font follows Dynamic Type, so one line can be far taller than the default body size (TAL-2569).
            let oneLineHeight = max(ComposerCardSizing.defaultOneLineInputHeight, ceil(textView.font?.lineHeight ?? 0))
            let fittingSize = CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
            let height = ceil(textView.sizeThatFits(fittingSize).height)
            onHeightChange(min(max(maximumHeight, oneLineHeight), max(oneLineHeight, height)), oneLineHeight)
        }
    }

    final class PastingTextView: ImagePastingTextView {
        var isKeyboardSendEnabled = false
        var keyboardSendKey = ComposerSendKey.defaultValue
        var alternateSendBehavior = StreamingSendBehavior.steer.alternate
        /// Receives the behavior override: nil for the send key, the alternate for Ctrl+Return.
        var onKeyboardSend: (StreamingSendBehavior?) -> Void = { _ in }
        var onPasteFileProviders: ([NSItemProvider]) -> Void = { _ in }
        var onPasteFileURLs: ([URL]) -> Void = { _ in }

        override func canPasteItemProviders(_ itemProviders: [NSItemProvider]) -> Bool {
            super.canPasteItemProviders(itemProviders) || (isEditable && itemProviders.contains {
                $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            })
        }

        override func pasteItemProviders(_ itemProviders: [NSItemProvider]) {
            guard isEditable else { return }
            let fileProviders = itemProviders.filter {
                $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            }

            if fileProviders.isEmpty {
                super.pasteItemProviders(itemProviders)
            } else {
                onPasteFileProviders(fileProviders)
            }
        }

        override var keyCommands: [UIKeyCommand]? {
            let composerCommands = ComposerKeyboardCommand.commands(
                sendKey: keyboardSendKey,
                alternateBehavior: alternateSendBehavior
            ).map { command in
                let keyCommand = UIKeyCommand(
                    title: command.title,
                    action: Self.selector(for: command.action),
                    input: ComposerKeyboardCommand.input,
                    modifierFlags: command.modifierFlags
                )
                // Plain Return must beat the text view's own newline insertion.
                keyCommand.wantsPriorityOverSystemBehavior = true
                if command.isHidden { keyCommand.attributes = .hidden }
                return keyCommand
            }
            return (super.keyCommands ?? []) + composerCommands
        }

        static func selector(for action: ComposerKeyboardCommand.Action) -> Selector {
            switch action {
            case .send: #selector(sendMessageFromKeyboard)
            case .alternateSend: #selector(sendAlternateFromKeyboard)
            case .newline: #selector(insertNewlineFromKeyboard)
            }
        }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            switch action {
            // A declined command falls through to the text view, so Return commits a marked-text
            // composition (TAL-159) instead of sending or inserting a newline mid-composition.
            case #selector(sendMessageFromKeyboard), #selector(sendAlternateFromKeyboard):
                return isKeyboardSendEnabled && markedTextRange == nil
            case #selector(insertNewlineFromKeyboard):
                return isEditable && markedTextRange == nil
            case #selector(paste(_:)) where isEditable && (!pasteboardFileProviders.isEmpty || !pasteboardFileURLs.isEmpty):
                return true
            default:
                return super.canPerformAction(action, withSender: sender)
            }
        }

        @objc func sendMessageFromKeyboard() {
            guard canPerformAction(#selector(sendMessageFromKeyboard), withSender: nil) else { return }
            onKeyboardSend(nil)
        }

        @objc func sendAlternateFromKeyboard() {
            guard canPerformAction(#selector(sendAlternateFromKeyboard), withSender: nil) else { return }
            onKeyboardSend(alternateSendBehavior)
        }

        /// UIKit also reads Ctrl+Return as a keyboard secondary click: a press-only gesture recognizer on the
        /// text view starts the edit menu, which then covers the composer and takes the next keystrokes.
        var isOpeningEditMenuFromControlReturn: Bool {
            (gestureRecognizers ?? []).contains { recognizer in
                recognizer.allowedTouchTypes.isEmpty
                    && !recognizer.allowedPressTypes.isEmpty
                    && [.began, .changed, .ended].contains(recognizer.state)
                    && recognizer.modifierFlags.contains(ComposerKeyboardCommand.alternateSendModifierFlags)
            }
        }

        /// Typed-text insertion, so undo, a selection replacement and the draft binding behave as for any key.
        @objc func insertNewlineFromKeyboard() {
            guard canPerformAction(#selector(insertNewlineFromKeyboard), withSender: nil) else { return }
            insertText("\n")
        }

        override func paste(_ sender: Any?) {
            guard isEditable else { return }
            let fileProviders = pasteboardFileProviders

            if !fileProviders.isEmpty {
                onPasteFileProviders(fileProviders)
                return
            }

            let fileURLs = pasteboardFileURLs
            if !fileURLs.isEmpty {
                onPasteFileURLs(fileURLs)
                return
            }

            super.paste(sender)
        }

        private var pasteboardFileProviders: [NSItemProvider] {
            UIPasteboard.general.itemProviders.filter {
                $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            }
        }

        private var pasteboardFileURLs: [URL] {
            UIPasteboard.general.urls?.filter(\.isFileURL) ?? []
        }
    }
}

/// Routes image paste to the owning editor's attachment pipeline and leaves text paste to UIKit.
class ImagePastingTextView: UITextView {
    var onPasteImageProviders: (([NSItemProvider]) -> Void)?
    var onPasteImages: (([UIImage]) -> Void)?
    private var targetEditability = true

    func applyEditability(_ isEditable: Bool) {
        targetEditability = isEditable
        let color: UIColor = isEditable ? .label : .secondaryLabel
        if textColor != color { textColor = color }
        guard self.isEditable != isEditable else { return }
        guard !isEditable, isFirstResponder else {
            self.isEditable = isEditable
            isSelectable = isEditable
            return
        }

        // Resigning the focused editor can lay out its hosting view during the SwiftUI update (TAL-415).
        Task { @MainActor [weak self, weak currentDelegate = delegate] in
            guard let self, let currentDelegate, self.delegate === currentDelegate else { return }
            self.isEditable = self.targetEditability
            self.isSelectable = self.targetEditability
        }
    }

    @objc(canPasteItemProviders:)
    func canPasteItemProviders(_ itemProviders: [NSItemProvider]) -> Bool {
        isEditable && itemProviders.contains {
            $0.hasItemConformingToTypeIdentifier(UTType.text.identifier)
                || (onPasteImageProviders != nil && $0.hasItemConformingToTypeIdentifier(UTType.image.identifier))
        }
    }

    @objc(pasteItemProviders:)
    func pasteItemProviders(_ itemProviders: [NSItemProvider]) {
        guard isEditable else { return }
        if !handleImageProviders(itemProviders), canPasteItemProviders(itemProviders) {
            paste(nil)
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), isEditable {
            let pasteboard = UIPasteboard.general
            if pasteboard.hasStrings
                || (onPasteImages != nil && pasteboard.hasImages)
                || canPasteItemProviders(pasteboard.itemProviders) { return true }
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard isEditable else { return }
        let pasteboard = UIPasteboard.general
        if handleImageProviders(pasteboard.itemProviders) { return }
        if let onPasteImages, let images = pasteboard.images, !images.isEmpty {
            onPasteImages(images)
            return
        }
        super.paste(sender)
    }

    private func handleImageProviders(_ providers: [NSItemProvider]) -> Bool {
        guard let onPasteImageProviders else { return false }
        let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard !images.isEmpty else { return false }
        onPasteImageProviders(images)
        return true
    }
}
