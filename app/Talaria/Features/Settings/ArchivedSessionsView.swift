import SwiftUI
import TalariaKit

struct ArchivedSessionsView: View {
    let server: URL
    /// Forwarded to `ChatView` and used for load/unarchive failures so a 401
    /// here triggers the same re-login flow as everywhere else.
    let onAPIError: (Error) -> Void
    /// The archived chat open beside the list at regular width.
    var selectedSessionID: String?

    /// Set at regular width, where an archived chat opens in the Archived section beside its
    /// list instead of being pushed over it (TAL-643).
    @Environment(\.openArchivedSession) private var openArchivedSession
    @State private var viewModel: ArchivedSessionsViewModel
    @State private var openedSession: SessionSummary?
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    init(server: URL, onAPIError: @escaping (Error) -> Void, selectedSessionID: String? = nil) {
        self.server = server
        self.onAPIError = onAPIError
        self.selectedSessionID = selectedSessionID
        _viewModel = State(initialValue: ArchivedSessionsViewModel(server: server))
    }

    var body: some View {
        content
            .adaptiveReadableScrollContent(maxWidth: AdaptiveReadableContentWidth.secondaryDestination)
            .navigationTitle("Archived Chats")
            .navigationDestination(item: $openedSession) { session in
                // Opening an archived session reuses the normal read path —
                // no special-casing on the chat side (issue #17).
                ChatView(session: session, server: server, onAPIError: onAPIError)
            }
            .task {
                await load()
            }
            .refreshesLive(on: .anyChange, showsStatus: !viewModel.sessions.isEmpty) {
                await load()
            }
            .refreshable {
                await load()
            }
            .alert(
                "Action Failed",
                isPresented: Binding(
                    get: { viewModel.actionErrorMessage != nil },
                    set: { isPresented in
                        if !isPresented {
                            viewModel.clearActionError()
                        }
                    }
                )
            ) {
                Button("OK") {
                    viewModel.clearActionError()
                }
            } message: {
                Text(viewModel.actionErrorMessage ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        SidebarList {
            if viewModel.sessions.isEmpty {
                statusRow
                    .padding(.horizontal, 24)
                    .sessionsScreenListRow()
            } else {
                ForEach(viewModel.sessions) { session in
                    archivedSessionRow(for: session)
                }
            }
        }
    }

    /// Loading, failure or empty, while there are no sessions to list.
    @ViewBuilder
    private var statusRow: some View {
        if viewModel.isLoading {
            ArchivedStatusRow(title: String(localized: "Loading archived sessions..."), systemImage: "archivebox")
        } else if let errorMessage = viewModel.errorMessage {
            VStack(alignment: .leading, spacing: 10) {
                ArchivedStatusRow(title: String(localized: "Could not load archived sessions"), systemImage: "exclamationmark.triangle")

                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)

                Button("Try Again") {
                    Task { await load() }
                }
                // A List makes a default-styled button's whole row its tap target.
                .buttonStyle(.plain)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
            }
        } else {
            ArchivedStatusRow(title: String(localized: "No archived sessions"), systemImage: "archivebox")
        }
    }

    private func archivedSessionRow(for session: SessionSummary) -> some View {
        HStack(spacing: 0) {
            Button {
                if let openArchivedSession {
                    openArchivedSession(session)
                } else {
                    openedSession = session
                }
            } label: {
                SessionRowView(
                    session: session,
                )
            }
            .buttonStyle(.plain)

            unarchiveButton(for: session)
        }
        .sidebarRow(isSelected: session.sessionId == selectedSessionID)
        .contextMenu {
            Button {
                unarchive(session)
            } label: {
                Label("Unarchive", systemImage: "arrow.up.bin")
            }
            .disabled(viewModel.isUnarchiving(session))
        }
    }

    /// Always-visible unarchive affordance; the context menu keeps the same
    /// action for discoverability parity with the main list's row menus.
    private func unarchiveButton(for session: SessionSummary) -> some View {
        Button {
            unarchive(session)
        } label: {
            Group {
                if viewModel.isUnarchiving(session) {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.bin")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isUnarchiving(session))
        .accessibilityLabel("Unarchive")
    }

    private func unarchive(_ session: SessionSummary) {
        Task {
            let didUnarchive = await viewModel.unarchive(session)
            handleLastError()
            if didUnarchive {
                SessionHaptics.archiveStateChanged(isEnabled: isHapticsEnabled)
            }
        }
    }

    private func load() async {
        await viewModel.load()
        handleLastError()
    }

    private func handleLastError() {
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}

private struct OpenArchivedSessionKey: EnvironmentKey {
    static let defaultValue: (@MainActor (SessionSummary) -> Void)? = nil
}

extension EnvironmentValues {
    var openArchivedSession: (@MainActor (SessionSummary) -> Void)? {
        get { self[OpenArchivedSessionKey.self] }
        set { self[OpenArchivedSessionKey.self] = newValue }
    }
}
