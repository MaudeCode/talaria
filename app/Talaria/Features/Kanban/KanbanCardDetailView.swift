import SwiftUI
import TalariaKit

struct KanbanCardDetailView: View {
    let featureModel: KanbanFeatureState
    @State private var state: KanbanCardDetailState?

    init(featureModel: KanbanFeatureState, cardID: String) {
        self.featureModel = featureModel
        _state = State(initialValue: featureModel.makeCardDetailState(cardID: cardID))
    }

    var body: some View {
        Group {
            if let state {
                KanbanCardDetailContent(featureModel: featureModel, state: state)
            } else {
                ContentUnavailableView("Unavailable", systemImage: "exclamationmark.triangle")
            }
        }
        .navigationTitle(state?.detail?.card?.title ?? String(localized: "Loading"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// TAL-2327: one Kanban card a transcript row opens: its board is selected first (the current one when the link names none
/// or one the server no longer lists), then the card's detail shows as it does from the board.
struct KanbanCardLinkView: View {
    let cardID: String
    let board: String?
    @State private var model: KanbanFeatureState
    @State private var boardSelected = false

    init(server: URL, cardID: String, board: String?, onAPIError: @escaping (Error) -> Void) {
        self.init(model: KanbanFeatureState(server: server, onAPIError: onAPIError, responseCache: .app(server: server)), cardID: cardID, board: board)
    }

    init(model: KanbanFeatureState, cardID: String, board: String?) {
        self.cardID = cardID
        self.board = board
        _model = State(initialValue: model)
    }

    var body: some View {
        Group {
            if boardSelected, model.selectedBoardSlug != nil {
                KanbanCardDetailView(featureModel: model, cardID: cardID)
            } else if boardSelected {
                ContentUnavailableView("Unavailable", systemImage: "exclamationmark.triangle")
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .navigationTitle(String(localized: "Loading"))
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
        .task {
            await model.loadIfNeeded()
            if let board { await model.selectBoard(board) }
            boardSelected = true
        }
    }
}

enum KanbanDetailDateFormatter {
    static func format(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        let date: Date?
        if let seconds = Double(value) {
            date = Date(timeIntervalSince1970: seconds > 100_000_000_000 ? seconds / 1_000 : seconds)
        } else {
            date = ISO8601DateFormatter().date(from: value)
        }
        guard let date else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

enum KanbanDurationFormatter {
    static func full(_ seconds: Int) -> String {
        formatter.string(from: TimeInterval(max(0, seconds))) ?? String(localized: "Unknown")
    }

    private static let formatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.maximumUnitCount = 2
        formatter.unitsStyle = .full
        return formatter
    }()
}
