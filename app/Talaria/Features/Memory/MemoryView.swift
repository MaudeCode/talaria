import SwiftUI
import TalariaKit

/// Memory's file list: one row per document with its modified time. A row selects the file,
/// which `MemoryFileView` shows beside the list or pushed over it (TAL-643).
struct MemoryView: View {
    let viewModel: MemoryViewModel
    @Binding var selection: SectionItem?
    let onAPIError: (Error) -> Void

    var body: some View {
        content
            .navigationTitle("Memory")
            .task {
                await loadMemory(viewModel, onAPIError: onAPIError)
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                guard viewModel.editingSection == nil else { return }
                await loadMemory(viewModel, onAPIError: onAPIError)
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
                    Task { await loadMemory(viewModel, onAPIError: onAPIError) }
                }
            }
        } else if !viewModel.hasLoaded {
            ProgressView("Loading memory...")
        } else {
            List {
                ForEach(MemorySection.allCases) { section in
                    SectionSelectionRow(item: .memory(.section(section)), selection: $selection) {
                        MemoryHeaderRow(
                            title: section.title,
                            systemImage: section.systemImage,
                            modifiedAt: viewModel.modifiedAt(for: section)
                        ) {
                            EmptyView()
                        }
                    }
                }

                if viewModel.showsProjectContext {
                    SectionSelectionRow(item: .memory(.projectContext), selection: $selection) {
                        ProjectContextSectionHeader(modifiedAt: viewModel.projectContextMtime)
                    }
                }
            }
            .refreshable {
                await loadMemory(viewModel, onAPIError: onAPIError)
            }
        }
    }
}

/// One Memory document with its Edit and Refresh actions.
struct MemoryFileView: View {
    @Bindable var viewModel: MemoryViewModel
    let file: MemoryFile
    let onAPIError: (Error) -> Void

    var body: some View {
        List {
            switch file {
            case .section(let section):
                MemorySectionContent(section: section, content: viewModel.content(for: section))
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
            case .projectContext:
                Section {
                    MarkdownRenderer(content: viewModel.projectContextText ?? "")
                        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                } footer: {
                    ProjectContextSectionFooter(
                        detail: viewModel.projectContextDetail,
                        isShadowed: viewModel.isProjectContextShadowed
                    )
                }
            }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if case .section(let section) = file {
                    Button {
                        viewModel.clearActionError()
                        viewModel.editingSection = section
                    } label: {
                        Label("Edit \(section.title)", systemImage: "pencil")
                    }
                    // Saves carry no version check, so cached notes are not editable (TAL-437).
                    .disabled(viewModel.isSaving || viewModel.isShowingCachedContent)
                }

                Button {
                    Task { await loadMemory(viewModel, onAPIError: onAPIError) }
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
        .sheet(item: $viewModel.editingSection) { section in
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
        .refreshable {
            await loadMemory(viewModel, onAPIError: onAPIError)
        }
    }

    private var title: String {
        switch file {
        case .section(let section): section.title
        case .projectContext: String(localized: "Project Context")
        }
    }
}

@MainActor
private func loadMemory(_ viewModel: MemoryViewModel, onAPIError: (Error) -> Void) async {
    await viewModel.load()

    if let lastError = viewModel.lastError {
        onAPIError(lastError)
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
