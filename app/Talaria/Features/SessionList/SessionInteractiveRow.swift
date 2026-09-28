import SwiftUI
import TalariaKit

struct SessionInteractiveRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let viewModel: SessionListViewModel
    let session: SessionSummary
    let showsMessageCount: Bool
    let showsWorkspace: Bool
    let selectedSessionID: String?
    let actions: SessionListRowActions
    var searchText = ""

    var body: some View {
        Button {
            actions.open(session)
        } label: {
            SessionRowView(
                session: session,
                showsMessageCount: showsMessageCount,
                showsWorkspace: showsWorkspace,
                isViewingCachedData: viewModel.isViewingCachedData,
                matchPreview: viewModel.contentMatchPreview(for: session, searchText: searchText),
                searchText: searchText
            )
        }
        .buttonStyle(.plain)
        .id(session.id)
        .background(
            session.sessionId == selectedSessionID
                ? Color.accentColor.opacity(0.12)
                : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .transition(SessionListMotion.sessionRowTransition(reduceMotion: reduceMotion))
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            sessionLeadingSwipeActions(for: session)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            sessionTrailingSwipeActions(for: session)
        }
        .contextMenu {
            SessionRowContextMenu(
                session: session,
                projects: viewModel.projects,
                isViewingCachedData: viewModel.isViewingCachedData,
                isRenamingSession: viewModel.isRenamingSession,
                isCreatingProject: viewModel.isCreatingProject,
                isMovingSession: viewModel.isMovingSession,
                isLoadingProjects: viewModel.isLoadingProjects,
                isMutating: viewModel.isMutating(session),
                actions: actions
            )
        }
        .sessionsScreenListRow(insets: EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
    }

    @ViewBuilder
    private func sessionLeadingSwipeActions(for session: SessionSummary) -> some View {
        if SessionRowActionPolicy.canPin(session), isLiveServerSession(session) {
            Button {
                actions.togglePinned(session)
            } label: {
                Label(session.pinned == true ? "Unpin" : "Pin", systemImage: "pin")
            }
            .disabled(viewModel.isMutating(session))
            .tint(.accentColor)
        }
    }

    @ViewBuilder
    private func sessionTrailingSwipeActions(for session: SessionSummary) -> some View {
        if SessionRowActionPolicy.canArchive(session), isLiveServerSession(session) {
            Button {
                actions.archive(session)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(viewModel.isMutating(session))
            .tint(.orange)
        }

        if canShowSessionMutationActions(for: session) {
            Button {
                actions.delete(session)
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(viewModel.isMutating(session))
            .tint(.red)
        }
    }

    private func canShowSessionMutationActions(for session: SessionSummary) -> Bool {
        SessionRowActionPolicy.offersMutationActions(for: session) && isLiveServerSession(session)
    }

    private func isLiveServerSession(_ session: SessionSummary) -> Bool {
        !viewModel.isViewingCachedData && hasServerSessionID(session)
    }
}
