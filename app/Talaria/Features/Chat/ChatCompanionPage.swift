import SwiftUI
import TalariaKit

/// TAL-1458: the file the agent is working on, on the page beside the chat. It follows the server's `focus_path` from
/// file to file; a file chosen in its browser pins it until Follow or the next run.
///
/// TAL-1539: the page keeps no bar of its own. Its controls join the chat's bar, so on the iPhone Duo the chat keeps the
/// vertical bar: a page with its own navigation bar took that bar over and hid every chat item. Its file name heads the
/// page instead, and its browser opens in place.
struct ChatCompanionPage: View {
    let viewModel: ChatViewModel
    let session: SessionSummary
    let server: URL
    let onAPIError: (Error) -> Void
    /// The file as loaded, shared with the page's other copy.
    let preview: CompanionPagePreview
    /// A copy sliding with the sidebar column leaves the bar to the page beside the chat (TAL-1540).
    var showsControls = true
    @State private var showsChanges = false
    @State private var browserSearch = FilesInspectorContent.Coordinator()

    var body: some View {
        let focus = viewModel.companionFocus
        VStack(alignment: .leading, spacing: 0) {
            if let browserPath = focus.browserPath {
                TextField("Search files", text: $browserSearch.searchText)
                    .textFieldStyle(.roundedBorder)
                    .padding([.horizontal, .top])
                FileBrowserView(
                    session: session,
                    server: server,
                    onAPIError: onAPIError,
                    initialPath: browserPath,
                    onPathChange: { viewModel.showCompanionBrowser(at: $0) },
                    inspectorSearch: browserSearch,
                    onOpenFile: { entry in
                        guard let path = entry.path else { return }
                        viewModel.pinCompanionFile(path)
                    }
                )
            } else if let path = focus.path {
                Text(Self.name(of: path))
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding([.horizontal, .top])
                    .accessibilityAddTraits(.isHeader)
                if showsChanges, let editDiff = focus.shownEditDiff {
                    ScrollView {
                        EditDiffHunks(editDiff: editDiff)
                            .padding()
                    }
                } else {
                    // A followed file reloads after each edit lands; a pinned one only when it changes.
                    let id = focus.isFollowing ? "\(path)#\(focus.editRevision)" : path
                    FilePreviewView(session: session, server: server, entry: WorkspaceEntry(name: Self.name(of: path), path: path),
                                    showsNavigationTitle: false,
                                    viewModel: preview.model(for: id) { FilePreviewViewModel(session: session, server: server, path: path) },
                                    onAPIError: onAPIError)
                        .id(id)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .toolbar {
            if showsControls {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if focus.browserPath != nil {
                        Button {
                            viewModel.showCompanionBrowser(at: nil)
                        } label: {
                            Label("Back", systemImage: "chevron.backward")
                        }
                    } else {
                        Toggle(isOn: following(focus)) {
                            Label("Follow", systemImage: "scope")
                        }
                        .toggleStyle(.button)
                        Button {
                            viewModel.showCompanionBrowser(at: ".")
                        } label: {
                            Label("Files", systemImage: "folder")
                        }
                        if focus.shownEditDiff != nil {
                            Toggle(isOn: $showsChanges) {
                                Label("Changes", systemImage: "plusminus")
                            }
                            .toggleStyle(.button)
                        }
                    }
                }
            }
        }
    }

    /// On follows the agent's file; off pins the one shown.
    private func following(_ focus: ChatCompanionFocus) -> Binding<Bool> {
        Binding(
            get: { focus.isFollowing },
            set: { follows in
                if follows {
                    viewModel.followCompanionFocus()
                } else if let path = focus.path {
                    viewModel.pinCompanionFile(path)
                }
            }
        )
    }

    private static func name(of path: String) -> String {
        (path as NSString).lastPathComponent
    }
}

/// TAL-1540: the companion page's loaded file, kept by its chat. The page beside the chat and its copy sliding with the
/// sidebar column share it, so a page that moves never shows its file loading again.
@MainActor
final class CompanionPagePreview {
    private var id: String?
    private var model: FilePreviewViewModel?

    func model(for id: String, make: () -> FilePreviewViewModel) -> FilePreviewViewModel {
        if id == self.id, let model { return model }
        let made = make()
        self.id = id
        model = made
        return made
    }
}
