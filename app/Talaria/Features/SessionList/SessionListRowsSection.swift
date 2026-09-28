import SwiftUI
import TalariaKit

struct SessionListRowsSection: View {
    let viewModel: SessionListViewModel

    let sessions: [SessionSummary]
    let emptyTitle: String
    let emptyDescription: String?
    let isSearchActive: Bool
    let searchText: String
    let showsMessageCount: Bool
    let showsWorkspace: Bool
    let selectedSessionID: String?
    let actions: SessionListRowActions
    var suppressEmptyState = false

    var body: some View {
        sessionsHeaderRow
            .padding(.top, 16)
            .sessionsScreenListRow()

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
            ForEach(sessions) { session in
                SessionInteractiveRow(
                    viewModel: viewModel,
                    session: session,
                    showsMessageCount: showsMessageCount,
                    showsWorkspace: showsWorkspace,
                    selectedSessionID: selectedSessionID,
                    actions: actions,
                    searchText: searchText
                )
            }
        }
    }

    private var sessionsHeaderRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if !isSearchActive {
                    Text("Sessions")
                        .font(.title3.bold())
                        .foregroundStyle(.primary)
                }

                Spacer()

                if viewModel.isSearchingRemoteSessions {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Searching sessions")
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
    }

    private var sessionLoadingSkeletonRows: some View {
        ForEach(Array(SessionRowSkeletonConfiguration.loadingRows.enumerated()), id: \.element.id) { index, row in
            SessionRowSkeletonView(
                configuration: row,
                showsMessageCount: showsMessageCount,
                showsWorkspace: showsWorkspace
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
