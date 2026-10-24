import SwiftUI
import TalariaKit

struct SessionListRowsSection: View {
    @Environment(\.sessionRowStyle) private var rowStyle
    let viewModel: SessionListViewModel

    let sessions: [SessionSummary]
    let emptyTitle: String
    let emptyDescription: String?
    let isSearchActive: Bool
    let searchText: String
    let selectedSessionID: String?
    let actions: SessionListRowActions
    var suppressEmptyState = false
    var showsHeading = true

    var body: some View {
        if rowStyle != .sidebar && (showsHeading || viewModel.isSearchingRemoteSessions) {
            sessionsHeaderRow
        } else if viewModel.isSearchingRemoteSessions {
            ProgressView().controlSize(.small).accessibilityLabel("Searching sessions")
                .sessionsScreenListRow()
        }

        if viewModel.isLoading && viewModel.sessions.isEmpty {
            sessionLoadingSkeletonRows
        } else if let errorMessage = viewModel.errorMessage, viewModel.sessions.isEmpty {
            sessionsErrorRow(message: errorMessage)
                .sessionsScreenListRow()
        } else if sessions.isEmpty && !suppressEmptyState {
            SessionListStatusRow(
                title: emptyTitle,
                description: emptyDescription,
                systemImage: "bubble.left"
            )
                .padding(.horizontal, 24)
                .sessionsScreenListRow()
        } else {
            if rowStyle == .sidebar {
                let pinned = sessions.filter { $0.pinned == true }
                if !pinned.isEmpty {
                    if showsHeading {
                        SidebarSectionHeader(title: String(localized: "Pinned"), isCompact: true) { EmptyView() }
                    }
                    ForEach(pinned) { session in sessionRow(session) }
                }
                if showsHeading {
                    SidebarSectionHeader(title: String(localized: "Recents"), isCompact: true) { EmptyView() }
                }
                ForEach(sessions.filter { $0.pinned != true }) { session in sessionRow(session) }
            } else {
                ForEach(sessions) { session in sessionRow(session) }
            }
        }
    }

    private func sessionRow(_ session: SessionSummary) -> some View {
        SessionInteractiveRow(
            viewModel: viewModel,
            session: session,
            selectedSessionID: selectedSessionID,
            actions: actions,
            searchText: searchText
        )
    }

    private var sessionsHeaderRow: some View {
        SidebarSectionHeader(title: isSearchActive || !showsHeading ? nil : String(localized: "Sessions"), topPadding: 8) {
            if viewModel.isSearchingRemoteSessions {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Searching sessions")
            }
        }
    }

    private var sessionLoadingSkeletonRows: some View {
        ForEach(Array(SessionRowSkeletonConfiguration.loadingRows.enumerated()), id: \.element.id) { index, row in
            SessionRowSkeletonView(
                configuration: row
            )
            .sessionsScreenListRow(insets: EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading sessions")
            .accessibilityHidden(index > 0)
        }
        .allowsHitTesting(false)
    }

    private func sessionsErrorRow(message errorMessage: String) -> some View {
        let content = sessionsErrorContent(fallbackMessage: errorMessage)

        return VStack(alignment: .leading, spacing: 10) {
            SessionListStatusRow(
                title: content.title,
                description: content.description,
                systemImage: "exclamationmark.triangle",
                descriptionLineLimit: 3
            )

            Button("Retry", action: actions.retryLoad)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .buttonStyle(.plain)
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                .accessibilityLabel("Retry loading sessions")
                .accessibilityHint("Attempts to reconnect to the server and reload sessions.")
        }
        .padding(.horizontal, 24)
    }

    private func sessionsErrorContent(fallbackMessage: String) -> (title: String, description: String) {
        if let sessionLoadError = viewModel.sessionLoadError,
           CacheFallbackPolicy.shouldUseCache(for: sessionLoadError) {
            return (
                String(localized: "Cannot reach server"),
                String(localized: "Check that your Mac is awake and cloudflared is running.")
            )
        }

        return (String(localized: "Could not load sessions"), fallbackMessage)
    }

}
