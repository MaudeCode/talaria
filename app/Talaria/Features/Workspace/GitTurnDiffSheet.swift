import SwiftUI
import TalariaKit

struct GitTurnDiffSheet: View {
    let session: SessionSummary
    let server: URL
    let files: [GitFile]
    let onAPIError: (Error) -> Void

    @State private var selectedFile: GitFile?
    @Environment(\.dismiss) private var dismiss

    private var title: String {
        files.count == 1
            ? String(localized: "1 file changed")
            : String(localized: "\(files.count) files changed")
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                }
        }
        .presentationDetents([.medium, .large])
        .adaptivePagePresentation()
        .sheet(item: $selectedFile) { file in
            GitDiffView(session: session, server: server, file: file, onAPIError: onAPIError)
        }
    }

    @ViewBuilder
    private var content: some View {
        if files.isEmpty {
            ContentUnavailableView(
                "No File Diffs",
                systemImage: "doc.text.magnifyingglass",
                description: Text("Diffs for this turn aren't available yet.")
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(files) { file in
                        Button {
                            selectedFile = file
                        } label: {
                            GitFileCard(file: file)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }
}
