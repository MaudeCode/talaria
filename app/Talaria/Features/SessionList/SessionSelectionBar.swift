import SwiftUI
import TalariaKit

/// Select Chats (TAL-627): the selected count, Select All for the chat rows, and the bulk
/// Archive and Delete actions. The server answers for each chat.
struct SessionSelectionBar: View {
    let viewModel: SessionListViewModel
    let sessions: [SessionSummary]
    let actions: SessionListRowActions
    let archive: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            Button(viewModel.allSelected(sessions) ? "Deselect All" : "Select All") {
                viewModel.toggleSelectAll(sessions)
            }
            .frame(minHeight: 44)

            Spacer(minLength: 0)

            if viewModel.isPerformingBulkAction {
                ProgressView()
            } else {
                Text("\(viewModel.selectedSessionCount) selected")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
            }

            Spacer(minLength: 0)

            SessionRowContextMenu(
                viewModel: viewModel,
                session: SessionSummary(),
                actions: selectionActions,
                placement: .selection
            )
            .labelStyle(.iconOnly)
            .controlSize(.large)
        }
        .padding(.horizontal)
        .padding(.vertical, 4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .disabled(viewModel.isPerformingBulkAction)
        .accessibilityElement(children: .contain)
    }

    private var selectionActions: SessionListRowActions {
        var result = actions
        result.archive = { _ in archive() }
        result.delete = { _ in delete() }
        return result
    }
}
