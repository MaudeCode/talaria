import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct SelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
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
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        if textView.text != text {
            textView.text = text
        }
    }
}
