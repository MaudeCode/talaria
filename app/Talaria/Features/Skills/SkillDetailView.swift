import SwiftUI
import TalariaKit

struct SkillDetailView: View {
    let skill: SkillSummary
    let server: URL
    let onAPIError: (Error) -> Void

    @State private var detail: SkillDetailResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var linkedFile: SkillLinkedFileSelection?

    var body: some View {
        content
            .navigationTitle(skill.name ?? String(localized: "Skill"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    RefreshToolbarButton(isLoading: isLoading) {
                        Task { await loadDetail() }
                    }
                }
            }
            .task {
                await loadDetail()
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                await loadDetail()
            }
            .sheet(item: $linkedFile) { file in
                NavigationStack {
                    SkillLinkedFileView(
                        fileName: file.fileName,
                        content: linkedFile?.content ?? file.content,
                        isLoading: linkedFile?.isLoading ?? file.isLoading
                    )
                }
                .adaptivePagePresentation()
                .task(id: file.fileName) {
                    await loadLinkedFile(named: file.fileName)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && detail == nil {
            ProgressView("Loading skill...")
        } else if let errorMessage, detail == nil {
            ContentUnavailableView {
                Label("Could Not Load Skill", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await loadDetail() }
                }
            }
        } else if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let content = detail.content, !content.isEmpty {
                        MarkdownRenderer(content: content)
                            .padding(.horizontal)
                    }

                    if let linkedFiles = detail.linkedFiles, !linkedFiles.isEmpty {
                        SkillLinkedFilesSection(
                            fileNames: linkedFiles,
                            onSelect: { fileName in
                                linkedFile = SkillLinkedFileSelection(fileName: fileName)
                            }
                        )
                    }
                }
                .padding(.vertical)
            }
        } else {
            ContentUnavailableView {
                Label("No Content", systemImage: "doc.text")
            } description: {
                Text("This skill has no content.")
            }
        }
    }

    private func loadDetail() async {
        guard let name = skill.name else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await APIClient(baseURL: server).skillContent(name: name)
            detail = response
        } catch {
            errorMessage = error.localizedDescription
            onAPIError(error)
        }
    }

    private func loadLinkedFile(named fileName: String) async {
        guard let name = skill.name else { return }
        let content = await SkillLinkedFileSelection.load(
            fileName: fileName,
            skill: name,
            client: APIClient(baseURL: server)
        )
        guard !Task.isCancelled else { return }
        linkedFile?.apply(content, for: fileName)
    }
}
