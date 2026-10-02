import SwiftUI
import TalariaKit

struct GitWorkspaceView: View {
    let onAPIError: (Error) -> Void

    private let session: SessionSummary
    private let server: URL
    @State private var viewModel: GitWorkspaceViewModel
    @State private var selectedFile: GitFile?
    @Environment(\.dismiss) private var dismiss

    init(session: SessionSummary, server: URL, onAPIError: @escaping (Error) -> Void) {
        self.session = session
        self.server = server
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: GitWorkspaceViewModel(session: session, server: server))
    }

    var body: some View {
        NavigationStack {
            content
                .adaptiveReadableScrollContent(maxWidth: AdaptiveReadableContentWidth.workspace)
                .navigationTitle("Git")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
                .task {
                    await viewModel.loadIfNeeded()
                    handleLastError()
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
        if viewModel.isLoading && viewModel.status == nil {
            ProgressView("Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.errorMessage != nil && viewModel.status == nil {
            unavailable("Could Not Load Changes", image: "exclamationmark.triangle", detail: viewModel.errorMessage) {
                Task { await reload() }
            }
        } else if viewModel.isNonRepository {
            ContentUnavailableView(
                "Not a Git Repository",
                systemImage: "folder.badge.questionmark",
                description: Text("Git actions are unavailable for this workspace.")
            )
        } else if let status = viewModel.status {
            statusContent(status)
        } else {
            unavailable("Could Not Load Changes", image: "exclamationmark.triangle", detail: viewModel.errorMessage) {
                Task { await reload() }
            }
        }
    }

    private func statusContent(_ status: GitStatus) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                summaryHeader(status)

                if status.trackedFiles.isEmpty {
                    ContentUnavailableView(
                        "No Changes",
                        systemImage: "checkmark.circle",
                        description: Text("Your working tree is clean.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 36)
                } else {
                    ForEach(status.trackedFiles) { file in
                        Button {
                            selectedFile = file
                        } label: {
                            GitFileCard(file: file)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if status.truncated == true {
                    Text("Showing first 500 changed files.")
                        .font(AppFont.footnote())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 6)
                }
            }
            .padding(16)
        }
        .refreshable { await reload() }
        .refreshesLive(on: .runEnded, showsStatus: viewModel.status != nil) { await reload() }
    }

    private func summaryHeader(_ status: GitStatus) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(status.changedCount) files changed")
                    .font(AppFont.subheadline(weight: .semibold))
                Spacer()
                DiffCountsLabel(additions: status.totalAdditions, deletions: status.totalDeletions)
            }

            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                Text(status.branch ?? "HEAD")
                    .font(AppFont.mono(style: .subheadline))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                GitAheadBehindBadges(ahead: status.ahead ?? 0, behind: status.behind ?? 0)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func unavailable(
        _ title: LocalizedStringKey,
        image: String,
        detail: String?,
        retry: @escaping () -> Void
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: image)
        } description: {
            if let detail { Text(detail) }
        } actions: {
            Button("Try Again", action: retry)
        }
    }

    private func reload() async {
        await viewModel.load()
        handleLastError()
    }

    private func handleLastError() {
        if let lastError = viewModel.lastError { onAPIError(lastError) }
    }
}
