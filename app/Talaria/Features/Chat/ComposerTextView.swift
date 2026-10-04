import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let revision: Int
    @Binding var isFocused: Bool
    let isDisabled: Bool
    let isKeyboardSendEnabled: Bool
    let onKeyboardSend: () -> Void
    let onHeightChange: (CGFloat) -> Void
    let onPasteFileProviders: ([NSItemProvider]) -> Void
    let onPasteFileURLs: ([URL]) -> Void
    let onPasteImageProviders: ([NSItemProvider]) -> Void
    let onPasteImages: ([UIImage]) -> Void

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
        textView.isKeyboardSendEnabled = isKeyboardSendEnabled
        textView.onKeyboardSend = onKeyboardSend
        textView.pasteConfiguration = UIPasteConfiguration(
            acceptableTypeIdentifiers: [
                UTType.fileURL.identifier,
                UTType.image.identifier,
                UTType.text.identifier
            ]
        )
        textView.onPasteFileProviders = onPasteFileProviders
        textView.onPasteFileURLs = onPasteFileURLs
        textView.onPasteImageProviders = onPasteImageProviders
        textView.onPasteImages = onPasteImages
        context.coordinator.reportHeight(for: textView)
        return textView
    }

    static func dismantleUIView(_ textView: PastingTextView, coordinator: Coordinator) {
        // A replaced question's field must not clear the new field's focus.
        textView.delegate = nil
    }

    func updateUIView(_ textView: PastingTextView, context: Context) {
        context.coordinator.onHeightChange = onHeightChange
        context.coordinator.applyBoundText(text, revision: revision, to: textView)
        // Mirror the chat RTL toggle onto the text view itself (#259): SwiftUI's
        // layoutDirection environment does not propagate into a wrapped UITextView,
        // so set the base direction directly so the cursor/empty-field rests on the
        // trailing edge. `.natural` keeps the LTR default untouched, and per-run
        // bidi still resolves mixed Arabic+Latin/URL content within the line.
        let isRTL = context.environment.layoutDirection == .rightToLeft
        textView.semanticContentAttribute = isRTL ? .forceRightToLeft : .unspecified
        textView.textAlignment = isRTL ? .right : .natural
        context.coordinator.applyEditability(!isDisabled, to: textView)
        textView.textColor = isDisabled ? .secondaryLabel : .label
        textView.isKeyboardSendEnabled = isKeyboardSendEnabled
        textView.onKeyboardSend = onKeyboardSend
        textView.onPasteFileProviders = onPasteFileProviders
        textView.onPasteFileURLs = onPasteFileURLs
        textView.onPasteImageProviders = onPasteImageProviders
        textView.onPasteImages = onPasteImages
        context.coordinator.syncFocus(for: textView, shouldFocus: isFocused, isDisabled: isDisabled)
        context.coordinator.reportHeight(for: textView)
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        @Binding var text: String
        @Binding var isFocused: Bool
        var onHeightChange: (CGFloat) -> Void
        private var pendingFocusTarget: Bool?
        // The newest draft revision this coordinator has acted on. An update carrying
        // an older one has been superseded, so applying it would replay a draft the
        // owner has already moved past.
        private var appliedRevision = Int.min
        // An external replacement that arrived mid-composition. Applying it straight
        // away would drop the marked text, so it waits for the composition to end and
        // is then applied exactly once.
        private var pendingExternalText: String?
        // The editability the latest update asked for; a deferred disable applies this value.
        private var targetEditability = true

        init(
            text: Binding<String>,
            isFocused: Binding<Bool>,
            onHeightChange: @escaping (CGFloat) -> Void
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

        func applyEditability(_ isEditable: Bool, to textView: UITextView) {
            targetEditability = isEditable
            guard textView.isEditable != isEditable else { return }
            guard !isEditable, textView.isFirstResponder else {
                textView.isEditable = isEditable
                textView.isSelectable = isEditable
                return
            }

            // Disabling the focused field resigns it, and the keyboard animation lays out the
            // hosting view inside this SwiftUI update: an AttributeGraph cycle that hangs the
            // main thread (TAL-415). Disable it once the update has finished.
            Task { @MainActor [weak self, weak textView] in
                guard let self, let textView, textView.delegate === self else { return }
                textView.isEditable = self.targetEditability
                textView.isSelectable = self.targetEditability
            }
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

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !isFocused {
                isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            flushPendingExternalText(into: textView)
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

            let fittingSize = CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
            let height = ceil(textView.sizeThatFits(fittingSize).height)
            onHeightChange(min(96, max(22, height)))
        }
    }

    final class PastingTextView: UITextView {
        var isKeyboardSendEnabled = false
        var onKeyboardSend: () -> Void = {}
        var onPasteFileProviders: ([NSItemProvider]) -> Void = { _ in }
        var onPasteFileURLs: ([URL]) -> Void = { _ in }
        var onPasteImageProviders: ([NSItemProvider]) -> Void = { _ in }
        var onPasteImages: ([UIImage]) -> Void = { _ in }

        func canPasteItemProviders(_ itemProviders: [NSItemProvider]) -> Bool {
            itemProviders.contains {
                $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                    || $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                    || $0.hasItemConformingToTypeIdentifier(UTType.text.identifier)
            }
        }

        func pasteItemProviders(_ itemProviders: [NSItemProvider]) {
            let fileProviders = itemProviders.filter {
                $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            }

            if fileProviders.isEmpty {
                let imageProviders = itemProviders.filter {
                    $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                }

                if imageProviders.isEmpty {
                    paste(nil)
                } else {
                    onPasteImageProviders(imageProviders)
                }
                return
            }

            onPasteFileProviders(fileProviders)
        }

        override var keyCommands: [UIKeyCommand]? {
            let sendCommand = UIKeyCommand(
                title: ComposerKeyboardCommand.title,
                action: #selector(sendMessageFromKeyboard),
                input: ComposerKeyboardCommand.input,
                modifierFlags: ComposerKeyboardCommand.modifierFlags
            )
            return (super.keyCommands ?? []) + [sendCommand]
        }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(sendMessageFromKeyboard) {
                return isKeyboardSendEnabled
            }

            if action == #selector(paste(_:)), hasPasteboardContent {
                return true
            }

            return super.canPerformAction(action, withSender: sender)
        }

        @objc private func sendMessageFromKeyboard() {
            guard isKeyboardSendEnabled else { return }
            onKeyboardSend()
        }

        override func paste(_ sender: Any?) {
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

            let imageProviders = pasteboardImageProviders
            if !imageProviders.isEmpty {
                onPasteImageProviders(imageProviders)
                return
            }

            let images = UIPasteboard.general.images ?? []
            if !images.isEmpty {
                onPasteImages(images)
                return
            }

            super.paste(sender)
        }

        private var hasPasteboardContent: Bool {
            let pasteboard = UIPasteboard.general
            return pasteboard.hasStrings
                || !pasteboardFileProviders.isEmpty
                || !pasteboardFileURLs.isEmpty
                || !pasteboardImageProviders.isEmpty
                || !(pasteboard.images?.isEmpty ?? true)
        }

        private var pasteboardFileProviders: [NSItemProvider] {
            UIPasteboard.general.itemProviders.filter {
                $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            }
        }

        private var pasteboardFileURLs: [URL] {
            UIPasteboard.general.urls?.filter(\.isFileURL) ?? []
        }

        private var pasteboardImageProviders: [NSItemProvider] {
            UIPasteboard.general.itemProviders.filter {
                $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
            }
        }
    }
}
