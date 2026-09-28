import SwiftUI
import TalariaKit

struct GroupedSessionsView: View {
    let title: String
    let isEnabled: Bool
    let emptySystemImage: String
    let includes: (SessionSummary) -> Bool
    let viewModel: SessionListViewModel
    let showsMessageCount: Bool
    let showsWorkspace: Bool
    let selectedSessionID: String?
    let actions: SessionListRowActions

    @State private var searchText = ""

    var body: some View {
        List {
            if sessions.isEmpty {
                SessionListStatusRow(
                    title: searchText.isEmpty
                        ? String(localized: "No sessions yet")
                        : String(localized: "No matching sessions"),
                    description: searchText.isEmpty
                        ? nil
                        : String(localized: "Try another search or project filter."),
                    systemImage: emptySystemImage
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
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .navigationTitle(title)
        .searchable(text: $searchText, prompt: "Search sessions")
    }

    private var sessions: [SessionSummary] {
        guard isEnabled else { return [] }

        return viewModel.visibleSessions(searchText: searchText, selectedProjectID: nil)
            .filter { includes($0) && $0.archived != true }
    }
}
