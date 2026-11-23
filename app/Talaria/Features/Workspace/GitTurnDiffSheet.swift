import SwiftUI
import TalariaKit

struct GitTurnDiffSheet: View {
    let session: SessionSummary
    let server: URL
    let files: [GitFile]
    let onAPIError: (Error) -> Void

    @State private var selectedFile: GitFile?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            GitTurnFilesList(files: files) { selectedFile = $0 }
                .navigationTitle(GitTurnFilesList.title(for: files))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                    .overflowPriority(.done)
                }
        }
        .presentationDetents([.medium, .large])
        .adaptivePagePresentation()
        .sheet(item: $selectedFile) { file in
            GitDiffView(session: session, server: server, file: file, onAPIError: onAPIError)
        }
    }
}

/// A turn's changed files, each opening its diff: the turn diff sheet's list, and the companion page's (TAL-1478).
struct GitTurnFilesList: View {
    let files: [GitFile]
    let onSelect: (GitFile) -> Void

    static func title(for files: [GitFile]) -> String {
        files.count == 1
            ? String(localized: "1 file changed")
            : String(localized: "\(files.count) files changed")
    }

    var body: some View {
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
                            onSelect(file)
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
