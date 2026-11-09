import SwiftUI
import TalariaKit

/// TAL-1966: the profile's decision reviews in the server's order. A row pushes its review; swipe and the context menu
/// open the review or its chat.
struct DecisionsListView: View {
    @State private var model: DecisionsListModel
    @Binding var selection: SectionItem?
    let openChat: (String) -> Void
    let onAPIError: (Error) -> Void

    init(server: URL, selection: Binding<SectionItem?>, openChat: @escaping (String) -> Void, onAPIError: @escaping (Error) -> Void) {
        self.init(model: DecisionsListModel(client: APIClient(baseURL: server)), selection: selection, openChat: openChat, onAPIError: onAPIError)
    }

    init(model: DecisionsListModel, selection: Binding<SectionItem?>, openChat: @escaping (String) -> Void, onAPIError: @escaping (Error) -> Void) {
        _model = State(initialValue: model)
        _selection = selection
        self.openChat = openChat
        self.onAPIError = onAPIError
    }

    var body: some View {
        content
            .background(Color(.systemBackground))
            .navigationTitle(String(localized: "Decisions"))
            .task { await load() }
            // A review's stream event from an open chat changes its row here too.
            .onReceive(NotificationCenter.default.publisher(for: .talariaDecisionReviewChanged)) { _ in
                Task { await load() }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let list = model.list, list.reviews.isEmpty {
            ContentUnavailableView(
                list.empty == .closed
                    ? String(localized: "Every decision review is applied or cancelled")
                    : String(localized: "No decision reviews yet"),
                systemImage: "checklist"
            )
        } else if model.list != nil {
            List {
                ForEach(model.rows) { row($0) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
            .accessibilityIdentifier("decisions-list")
        } else if let error = model.loadError {
            ContentUnavailableView {
                Label(String(localized: "Could Not Load Decisions"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(error.localizedDescription)
            } actions: {
                Button(String(localized: "Try Again")) { Task { await load() } }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func row(_ row: DecisionReviewRow) -> some View {
        Button { open(row) } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.title)
                        .font(.headline)
                        .lineLimit(2)
                    Text(DecisionReviewResultSection.statusLabel(row.status))
                        .kindChip()
                        .fixedSize()
                    Spacer(minLength: 4)
                    Text(String(localized: "\(row.progress.answered) of \(row.progress.total) answered"))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Image(systemName: "chevron.forward")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                Text(row.sessionTitle ?? String(localized: "Untitled"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
        .listRowBackground(Color(.systemBackground))
        .accessibilityElement(children: .combine)
        .accessibilityHint(String(localized: "Opens the decision review."))
        .accessibilityIdentifier("decision-review-row-\(row.reviewId)")
        .swipeActions(edge: .trailing) {
            Button { openChat(row.sessionId) } label: { Label(String(localized: "Open chat"), systemImage: "bubble.left") }
                .tint(.accentColor)
            Button { open(row) } label: { Label(String(localized: "Open"), systemImage: "arrow.right.circle") }
                .tint(.gray)
        }
        .contextMenu {
            Button { open(row) } label: { Label(String(localized: "Open"), systemImage: "arrow.right.circle") }
            Button { openChat(row.sessionId) } label: { Label(String(localized: "Open chat"), systemImage: "bubble.left") }
        }
    }

    private func open(_ row: DecisionReviewRow) {
        selection = .decisionReview(id: row.reviewId)
    }

    private func load() async {
        await model.load()
        if let error = model.loadError { onAPIError(error) }
    }
}
