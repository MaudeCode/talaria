import SwiftUI
import TalariaKit

struct SkillLinkedFileView: View {
    let fileName: String
    let content: String?
    let isLoading: Bool

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading file...")
            } else if let content, !content.isEmpty {
                ScrollView {
                    MarkdownRenderer(content: content)
                        .padding()
                }
            } else {
                ContentUnavailableView {
                    Label("No Content", systemImage: "doc.text")
                } description: {
                    Text("This file appears to be empty.")
                }
            }
        }
        .navigationTitle(fileName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") {
                    dismiss()
                }
            }
        }
    }
}
