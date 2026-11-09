import Foundation
import Observation

/// TAL-1966: the Decisions list's state. `list` is the server's last copy, rows in its order; a failed reload keeps it.
@MainActor
@Observable
public final class DecisionsListModel {
    public private(set) var list: DecisionReviewList?
    /// The last load's failure; the screen shows it only while no list is shown.
    public private(set) var loadError: Error?
    @ObservationIgnored private let client: APIClient

    public init(client: APIClient, list: DecisionReviewList? = nil) {
        self.client = client
        self.list = list
    }

    public var rows: [DecisionReviewRow] { list?.reviews ?? [] }

    public func load() async {
        do {
            list = try await client.decisionReviews()
            loadError = nil
        } catch {
            loadError = error
        }
    }
}
