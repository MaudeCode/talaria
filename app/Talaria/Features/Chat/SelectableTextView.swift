import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct SelectableTextView: UIViewRepresentable {
    let text: String
    var isLogTail = false

    func makeUIView(context: Context) -> UITextView {
        let textView = isLogTail ? UITextView(usingTextLayoutManager: false) : UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.backgroundColor = .systemBackground
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        // A wrapped UITextView does not inherit SwiftUI's layoutDirection; `.natural`
        // lets each paragraph align by its own writing direction so RTL message text
        // reads right-aligned while LTR stays left-aligned (issue #294).
        textView.textAlignment = .natural
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 32, right: 16)
        textView.textContainer.lineFragmentPadding = 0
        textView.alwaysBounceVertical = true
        if isLogTail {
            textView.textAlignment = .left
            textView.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
            textView.textContainer.widthTracksTextView = false
            textView.alwaysBounceHorizontal = true
        }
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        var changed = textView.text != text
        if changed { textView.text = text }
        guard isLogTail else { return }
        let descriptor = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: textView.traitCollection).fontDescriptor
        let font = UIFont(descriptor: descriptor.withDesign(.monospaced) ?? descriptor, size: 0)
        if textView.font != font {
            textView.font = font
            changed = true
        }
        if changed {
            // A newly mounted text view needs its viewport before it can reveal the final line.
            DispatchQueue.main.async {
                guard textView.text == text else { return }
                textView.layoutIfNeeded()
                textView.textContainer.size = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
                textView.layoutManager.ensureLayout(for: textView.textContainer)
                let used = textView.layoutManager.usedRect(for: textView.textContainer)
                let width = max(textView.bounds.width, ceil(used.maxX) + 1)
                textView.textContainer.size.width = width
                textView.layoutManager.ensureLayout(for: textView.textContainer)
                textView.contentSize = CGSize(width: width,
                                              height: ceil(used.maxY) + textView.textContainerInset.top + textView.textContainerInset.bottom)
                textView.setContentOffset(CGPoint(x: 0, y: max(0, textView.contentSize.height - textView.bounds.height)), animated: false)
            }
        }
    }
}
