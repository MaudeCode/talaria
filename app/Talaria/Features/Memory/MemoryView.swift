import SwiftUI
import TalariaKit

struct MemoryView: View {
    let server: URL
    let onAPIError: (Error) -> Void

    @State private var viewModel: MemoryViewModel
    @State private var editingSection: MemorySection?

    init(server: URL, onAPIError: @escaping (Error) -> Void) {
        self.server = server
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: MemoryViewModel(server: server, responseCache: .app(server: server)))
    }

    var body: some View {
        content
            .navigationTitle("Memory")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await loadMemory() }
                    } label: {
                        if viewModel.isLoading {
                            ProgressView()
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .sheet(item: $editingSection) { section in
                MemoryEditSheet(
                    section: section,
                    initialContent: viewModel.content(for: section),
                    isSaving: viewModel.isSaving,
                    errorMessage: viewModel.actionErrorMessage
                ) { content in
                    let didSave = await viewModel.save(section: section, content: content)
                    if let lastError = viewModel.lastError {
                        onAPIError(lastError)
                    }
                    return didSave
                }
            }
            .task {
                await loadMemory()
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                guard editingSection == nil else { return }
                await loadMemory()
            }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && !viewModel.hasLoaded {
            ProgressView("Loading memory...")
        } else if let errorMessage = viewModel.errorMessage, !viewModel.hasLoaded {
            ContentUnavailableView {
                Label("Could Not Load Memory", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await loadMemory() }
                }
            }
        } else if !viewModel.hasLoaded {
            ProgressView("Loading memory...")
        } else {
            List {
                ForEach(MemorySection.allCases) { section in
                    Section {
                        MemorySectionContent(
                            section: section,
                            content: viewModel.content(for: section)
                        )
                            .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                    } header: {
                        MemorySectionHeader(
                            section: section,
                            modifiedAt: viewModel.modifiedAt(for: section),
                            // Saves carry no version check, so cached notes are not editable (TAL-437).
                            isEditingDisabled: viewModel.isSaving || viewModel.isShowingCachedContent
                        ) {
                            viewModel.clearActionError()
                            editingSection = section
                        }
                    }
                }

                if viewModel.showsProjectContext {
                    Section {
                        MarkdownRenderer(content: viewModel.projectContextText ?? "")
                            .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                    } header: {
                        ProjectContextSectionHeader(modifiedAt: viewModel.projectContextMtime)
                    } footer: {
                        ProjectContextSectionFooter(
                            detail: viewModel.projectContextDetail,
                            isShadowed: viewModel.isProjectContextShadowed
                        )
                    }
                }
            }
            .refreshable {
                await loadMemory()
            }
        }
    }

    private func loadMemory() async {
        await viewModel.load()

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}


/// Header for the read-only project-context document: no edit affordance — the
/// server has no write path for this section — so a lock icon marks it read-only.




extension MemorySection {
    var title: String {
        switch self {
        case .memory:
            return String(localized: "My Notes")
        case .user:
            return String(localized: "User Profile")
        case .soul:
            return String(localized: "Agent Soul")
        }
    }

    var emptyMessage: String {
        switch self {
        case .memory:
            return String(localized: "No notes yet.")
        case .user:
            return String(localized: "No profile yet.")
        case .soul:
            return String(localized: "No soul defined yet.")
        }
    }

    var systemImage: String {
        switch self {
        case .memory:
            return "brain"
        case .user:
            return "person.crop.circle"
        case .soul:
            return "sparkles"
        }
    }
}
