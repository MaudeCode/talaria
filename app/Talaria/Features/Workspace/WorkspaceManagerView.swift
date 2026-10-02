import SwiftUI
import TalariaKit

/// Workspace-registry management sheet (issue #22): add, rename, reorder, and
/// remove registered workspaces. Removal only unregisters a path from the
/// server's list — it never deletes files — and is confirmation-gated.
struct WorkspaceManagerView: View {
    @State private var viewModel: WorkspaceRegistryViewModel

    /// Called when the sheet disappears after at least one successful mutation,
    /// so the presenting surface can refresh its own copy of the registry.
    private let onRegistryChanged: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showsAddSheet = false
    @State private var renameTargetPath: String?
    @State private var renameText = ""

    init(server: URL, onRegistryChanged: @escaping () async -> Void) {
        _viewModel = State(initialValue: WorkspaceRegistryViewModel(server: server))
        self.onRegistryChanged = onRegistryChanged
    }

    init(viewModel: WorkspaceRegistryViewModel, onRegistryChanged: @escaping () async -> Void) {
        _viewModel = State(initialValue: viewModel)
        self.onRegistryChanged = onRegistryChanged
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage = viewModel.errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if viewModel.managementUnavailable {
                    Section {
                        Text("Workspace management isn't available on this server.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if !viewModel.rows.isEmpty {
                    Section {
                        ForEach(viewModel.rows, id: \.path) { workspace in
                            // moveDisabled/deleteDisabled block new drags and
                            // swipe-deletes while a mutation is in flight:
                            // actor reentrancy across the network await would
                            // otherwise let overlapping mutations race (the
                            // view model's generation guard is the second
                            // line of defense).
                            workspaceRow(workspace)
                                .moveDisabled(viewModel.isMutating)
                                .deleteDisabled(viewModel.isMutating)
                        }
                        .onMove { source, destination in
                            Task {
                                await viewModel.moveWorkspaces(fromOffsets: source, toOffset: destination)
                            }
                        }
                        .onDelete { offsets in
                            guard let index = offsets.first, viewModel.rows.indices.contains(index) else { return }
                            viewModel.requestRemoval(of: viewModel.rows[index])
                        }
                    } footer: {
                        Text("Removing a workspace only unregisters its path from the server's list. No files are deleted.")
                    }
                } else if !viewModel.isLoading {
                    ContentUnavailableView {
                        Label("No Workspaces", systemImage: "folder")
                    } description: {
                        Text("Add a workspace to make it available when starting sessions.")
                    }
                }
            }
            .navigationTitle("Manage Workspaces")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") {
                        dismiss()
                    }
                }

                ToolbarItemGroup(placement: .topBarTrailing) {
                    EditButton()
                        .disabled(viewModel.rows.isEmpty)

                    Button {
                        showsAddSheet = true
                    } label: {
                        Label("Add Workspace", systemImage: "plus")
                    }
                    .disabled(viewModel.isMutating)
                }
            }
            .overlay {
                if viewModel.isLoading && viewModel.rows.isEmpty {
                    ProgressView()
                }
            }
            .task {
                await viewModel.load()
            }
            .refreshesLive(showsStatus: !viewModel.rows.isEmpty) {
                await viewModel.load()
            }
            .sheet(isPresented: $showsAddSheet) {
                WorkspaceAddSheet(viewModel: viewModel)
            }
            .alert(
                "Rename Workspace",
                isPresented: renameAlertBinding
            ) {
                TextField("Workspace name", text: $renameText)
                Button("Cancel", role: .cancel) {
                    renameTargetPath = nil
                }
                Button("Save") {
                    let path = renameTargetPath
                    let name = renameText
                    renameTargetPath = nil
                    guard let path else { return }
                    Task {
                        await viewModel.renameWorkspace(path: path, to: name)
                    }
                }
            }
            .confirmationDialog(
                "Remove Workspace?",
                isPresented: removalDialogBinding,
                titleVisibility: .visible,
                presenting: viewModel.pendingRemoval
            ) { workspace in
                // `presenting:` hands the staged workspace to this closure at
                // presentation time — the dismissal binding clears
                // `pendingRemoval` before this async task runs, so the target
                // must not be re-read from the view model here.
                Button("Remove", role: .destructive) {
                    Task { @MainActor in
                        await viewModel.confirmRemoval(of: workspace)
                    }
                }
                Button("Cancel", role: .cancel) {
                    viewModel.cancelPendingRemoval()
                }
            } message: { _ in
                Text("Removing a workspace only unregisters its path from the server's list. No files are deleted.")
            }
            .onDisappear {
                guard viewModel.didMutateRegistry else { return }
                Task {
                    await onRegistryChanged()
                }
            }
        }
        .adaptiveFormPresentation()
    }

    private func workspaceRow(_ workspace: WorkspaceRoot) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(displayName(for: workspace))
                .font(.body)

            if let path = workspace.path {
                Text(path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                renameText = workspace.name ?? ""
                renameTargetPath = workspace.path
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .tint(.blue)
            .disabled(viewModel.isMutating)
        }
    }

    private func displayName(for workspace: WorkspaceRoot) -> String {
        if let name = workspace.name, !name.isEmpty {
            return name
        }
        return workspace.path?.lastPathComponentFallback ?? ""
    }

    private var renameAlertBinding: Binding<Bool> {
        Binding(
            get: { renameTargetPath != nil },
            set: { isPresented in
                if !isPresented {
                    renameTargetPath = nil
                }
            }
        )
    }

    private var removalDialogBinding: Binding<Bool> {
        Binding(
            get: { viewModel.pendingRemoval != nil },
            set: { isPresented in
                if !isPresented {
                    viewModel.cancelPendingRemoval()
                }
            }
        )
    }
}

/// Add-workspace form: path (with server suggestions), optional display name,
/// and an opt-in "create the folder" flag mirroring the web UI's Add Space.
