import SwiftUI
import TalariaKit

struct SelectableTextPresentationView: View {
    let selection: SelectableTextPresentation

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableTextView(text: selection.text)
                .accessibilityIdentifier("selectable-response-text")
                .background(Color(.systemBackground))
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") {
                            dismiss()
                        }
                    }
                }
        }
    }
}
