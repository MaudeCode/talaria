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


enum KanbanDetailDateFormatter {
    static func format(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        let date: Date?
        if let seconds = Double(value) {
            date = Date(timeIntervalSince1970: seconds > 100_000_000_000 ? seconds / 1_000 : seconds)
        } else {
            date = iso8601.date(from: value)
        }
        guard let date else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private static let iso8601 = ISO8601DateFormatter()
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
