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

/// Sheet state for one linked skill file. Responses carry the file name they
/// were requested for, so a slow request cannot land in a later presentation.
struct SkillLinkedFileSelection: Identifiable, Equatable {
    let fileName: String
    private(set) var content: String?

    var id: String { fileName }
    var isLoading: Bool { content == nil }

    init(fileName: String) {
        self.fileName = fileName
    }

    /// Applies a response only when it belongs to the presented file.
    mutating func apply(_ response: String, for fileName: String) {
        guard self.fileName == fileName else { return }
        content = response
    }

    static func load(fileName: String, skill: String, client: APIClient) async -> String {
        do {
            return try await client.skillContent(name: skill, file: fileName).content ?? ""
        } catch {
            return String(localized: "Could not load file: \(error.localizedDescription)")
        }
    }
}
