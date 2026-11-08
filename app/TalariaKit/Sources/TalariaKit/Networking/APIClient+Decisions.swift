import Foundation

/// TAL-1965: the decision review routes (`/api/decisions/…`). Each write answers with the whole review.
extension APIClient {
    public func decisionReview(id: String) async throws -> DecisionReview {
        try await send(endpoint: .decisionReview(id: id), method: "GET")
    }

    public func answerDecision(_ input: DecisionAnswerInput) async throws -> DecisionReview {
        try await send(endpoint: .decisionAnswer(reviewID: input.reviewId, itemID: input.itemId), method: "PUT", body: input)
    }

    public func submitDecisionReview(id: String) async throws -> DecisionReview {
        try await send(endpoint: .decisionSubmit(reviewID: id), method: "POST")
    }
}

/// What a 409 `answer_conflict` or `item_changed` refusal holds: the stored answer (nil when the item has none) and its
/// `answer_version`.
public struct DecisionStoredAnswer: Decodable, Equatable, Sendable {
    public let answer: DecisionAnswer?
    public let answerVersion: Int
}

extension APIError {
    /// The stored answer a 409 `answer_conflict` or `item_changed` refusal carries; nil for any other error.
    public var decisionStoredAnswer: DecisionStoredAnswer? {
        guard case .http(409, let body) = self, let body, ["answer_conflict", "item_changed"].contains(serverCode ?? "")
        else { return nil }
        return try? DecisionReview.decoder.decode(DecisionStoredAnswer.self, from: Data(body.utf8))
    }
}
