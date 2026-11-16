import SwiftUI
import TalariaKit

struct GroupedSessionsView: View {
    @Environment(\.sessionRowStyle) private var rowStyle
    let title: String
    let isEnabled: Bool
    let emptySystemImage: String
    let includes: (SessionSummary) -> Bool
    let viewModel: SessionListViewModel
    let selectedSessionID: String?
    let actions: SessionListRowActions

    @State private var searchText = ""

    var body: some View {
        let rows = SessionInteractiveRow.rows(sessions, viewModel: viewModel, selectedSessionID: selectedSessionID, actions: actions,
                                              searchText: searchText, style: rowStyle)
        SidebarList {
            if rows.isEmpty {
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
                ForEach(rows, id: \.session.id) { $0.equatable() }
            }
        }
        .navigationTitle(title)
        .searchable(text: $searchText, prompt: "Search sessions")
    }

    private var sessions: [SessionSummary] {
        guard isEnabled else { return [] }

        return viewModel.visibleSessions(searchText: searchText, selectedProjectID: nil)
            .filter { includes($0) && $0.archived != true }
    }
}
