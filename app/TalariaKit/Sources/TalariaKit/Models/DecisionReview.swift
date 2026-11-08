import Foundation

/// TAL-1965: a decision review an agent hands the user (`DecisionReviewSchema`). The server owns the order, progress,
/// freshness, `needs_review`, `submit`, the filters, `next_item_id` and every outcome; the App renders these fields.
/// Every decision model decodes with a snake-case-converting decoder (`DecisionReview.decoder`), so a payload read from
/// the API, a session detail, a tool result or a stream event lands in the same camel-case keys.
public struct DecisionReview: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Equatable, Sendable {
        case open, submitted, applied, cancelled
    }

    public let reviewId: String
    public let sessionId: String
    public let title: String
    public let intro: String?
    public let status: Status
    /// When the server last changed the review; a later copy never has an earlier one.
    public let updatedAt: Double
    public let progress: DecisionProgress
    public let submit: DecisionSubmit
    /// In display order: the server's, never re-sorted.
    public var items: [DecisionItem]
    /// TAL-1964: the answers view's filters, item ids in display order; `all` is `items`.
    public let filters: DecisionFilters
    /// TAL-1964: the item Continue opens; nil when none is left.
    public let nextItemId: String?

    public init(
        reviewId: String, sessionId: String, title: String, intro: String? = nil, status: Status, updatedAt: Double = 0, progress: DecisionProgress,
        submit: DecisionSubmit, items: [DecisionItem], filters: DecisionFilters = DecisionFilters(new: [], pending: []), nextItemId: String? = nil
    ) {
        self.reviewId = reviewId
        self.sessionId = sessionId
        self.title = title
        self.intro = intro
        self.status = status
        self.updatedAt = updatedAt
        self.progress = progress
        self.submit = submit
        self.items = items
        self.filters = filters
        self.nextItemId = nextItemId
    }

    enum CodingKeys: String, CodingKey {
        case reviewId, sessionId, title, intro, status, updatedAt, progress, submit, items, filters, nextItemId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reviewId = try container.decode(String.self, forKey: .reviewId)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId) ?? ""
        title = container.decodeLossyStringIfPresent(forKey: .title) ?? ""
        intro = container.decodeLossyStringIfPresent(forKey: .intro)
        status = (try? container.decode(Status.self, forKey: .status)) ?? .open
        updatedAt = container.decodeLossyDoubleIfPresent(forKey: .updatedAt) ?? 0
        progress = (try? container.decode(DecisionProgress.self, forKey: .progress)) ?? DecisionProgress(total: 0, answered: 0)
        submit = (try? container.decode(DecisionSubmit.self, forKey: .submit)) ?? DecisionSubmit(allowed: false, reason: nil)
        items = container.decodeLossyArrayIfPresent(DecisionItem.self, forKey: .items) ?? []
        filters = (try? container.decode(DecisionFilters.self, forKey: .filters)) ?? DecisionFilters(new: [], pending: [])
        nextItemId = container.decodeLossyStringIfPresent(forKey: .nextItemId)
    }

    /// The decoder every decision payload goes through.
    public static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    /// A decision model held in an already-decoded JSON field; nil when it is absent or unreadable.
    static func decode<Model: Decodable>(_ type: Model.Type, from value: JSONValue?) -> Model? {
        guard let value, case .object = value, let data = try? JSONEncoder().encode(value) else { return nil }
        return try? decoder.decode(type, from: data)
    }

    public func item(id: String) -> DecisionItem? {
        items.first { $0.id == id }
    }
}

public struct DecisionChoice: Decodable, Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let effect: String
    public var id: String { value }

    public init(value: String, label: String, effect: String) {
        self.value = value
        self.label = label
        self.effect = effect
    }
}

public struct DecisionTechnical: Decodable, Equatable, Sendable {
    public let detail: String?
    public let sources: [String]

    public init(detail: String? = nil, sources: [String] = []) {
        self.detail = detail
        self.sources = sources
    }

    enum CodingKeys: String, CodingKey { case detail, sources }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        detail = container.decodeLossyStringIfPresent(forKey: .detail)
        sources = (try? container.decode([String].self, forKey: .sources)) ?? []
    }
}

/// The user's answer as it was shown when saved: a deferred or custom answer has no choice, and a custom one's text is
/// `notes`. `version` starts at 1 and grows with every save.
public struct DecisionAnswer: Decodable, Equatable, Sendable {
    public let value: String?
    public let label: String?
    public let effect: String?
    public let notes: String
    public let deferred: Bool
    public let custom: Bool
    public let version: Int

    public init(value: String?, label: String?, effect: String?, notes: String, deferred: Bool, custom: Bool, version: Int) {
        self.value = value
        self.label = label
        self.effect = effect
        self.notes = notes
        self.deferred = deferred
        self.custom = custom
        self.version = version
    }

    enum CodingKeys: String, CodingKey { case value, label, effect, notes, deferred, custom, version }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = container.decodeLossyStringIfPresent(forKey: .value)
        label = container.decodeLossyStringIfPresent(forKey: .label)
        effect = container.decodeLossyStringIfPresent(forKey: .effect)
        notes = container.decodeLossyStringIfPresent(forKey: .notes) ?? ""
        deferred = container.decodeLossyBoolIfPresent(forKey: .deferred) ?? false
        custom = container.decodeLossyBoolIfPresent(forKey: .custom) ?? false
        version = try container.decode(Int.self, forKey: .version)
    }
}

/// What the agent recorded for an answer. A state this build does not know decodes as `.other`.
public struct DecisionOutcome: Decodable, Equatable, Sendable {
    public enum State: String, Equatable, Sendable {
        case applied, kept, blocked, reviewed, planned, other
    }

    public let state: State
    public let note: String?

    public init(state: State, note: String? = nil) {
        self.state = state
        self.note = note
    }

    enum CodingKeys: String, CodingKey { case state, note }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = container.decodeLossyStringIfPresent(forKey: .state).flatMap(State.init(rawValue:)) ?? .other
        note = container.decodeLossyStringIfPresent(forKey: .note)
    }
}

/// One decision. `fresh` compares it with the review's previous revision; `needsReview` is an answer given to content the
/// item no longer has. `answerVersion` counts every save and clear of the answer and never goes back; a write sends it as
/// `expected_version`.
public struct DecisionItem: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let question: String
    public let explanation: String
    public let example: String?
    public let current: String
    public let recommendation: String
    public let recommendedChoice: String
    public let choices: [DecisionChoice]
    public let technical: DecisionTechnical
    public let contentHash: String
    public var needsReview: Bool
    public var answer: DecisionAnswer?
    public var answerVersion: Int
    public var outcome: DecisionOutcome?

    public init(
        id: String, title: String, question: String, explanation: String, example: String? = nil, current: String,
        recommendation: String, recommendedChoice: String, choices: [DecisionChoice], technical: DecisionTechnical = DecisionTechnical(),
        contentHash: String, needsReview: Bool = false, answer: DecisionAnswer? = nil, answerVersion: Int = 0, outcome: DecisionOutcome? = nil
    ) {
        self.id = id
        self.title = title
        self.question = question
        self.explanation = explanation
        self.example = example
        self.current = current
        self.recommendation = recommendation
        self.recommendedChoice = recommendedChoice
        self.choices = choices
        self.technical = technical
        self.contentHash = contentHash
        self.needsReview = needsReview
        self.answer = answer
        self.answerVersion = answerVersion
        self.outcome = outcome
    }

    enum CodingKeys: String, CodingKey {
        case id, title, question, explanation, example, current, recommendation, recommendedChoice, choices, technical
        case contentHash, needsReview, answer, answerVersion, outcome
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = container.decodeLossyStringIfPresent(forKey: .title) ?? ""
        question = container.decodeLossyStringIfPresent(forKey: .question) ?? ""
        explanation = container.decodeLossyStringIfPresent(forKey: .explanation) ?? ""
        example = container.decodeLossyStringIfPresent(forKey: .example)
        current = container.decodeLossyStringIfPresent(forKey: .current) ?? ""
        recommendation = container.decodeLossyStringIfPresent(forKey: .recommendation) ?? ""
        recommendedChoice = container.decodeLossyStringIfPresent(forKey: .recommendedChoice) ?? ""
        choices = container.decodeLossyArrayIfPresent(DecisionChoice.self, forKey: .choices) ?? []
        technical = (try? container.decode(DecisionTechnical.self, forKey: .technical)) ?? DecisionTechnical()
        contentHash = container.decodeLossyStringIfPresent(forKey: .contentHash) ?? ""
        needsReview = container.decodeLossyBoolIfPresent(forKey: .needsReview) ?? false
        answer = try? container.decodeIfPresent(DecisionAnswer.self, forKey: .answer)
        answerVersion = container.decodeLossyIntIfPresent(forKey: .answerVersion) ?? 0
        outcome = try? container.decodeIfPresent(DecisionOutcome.self, forKey: .outcome)
    }
}

/// `answered` counts chosen and custom answers, `deferred` deferred ones.
public struct DecisionProgress: Decodable, Equatable, Hashable, Sendable {
    public let total: Int
    public let answered: Int

    public init(total: Int, answered: Int) {
        self.total = total
        self.answered = answered
    }
}

/// Submit is allowed on an open review with at least one answered item; otherwise `reason` says why.
public struct DecisionSubmit: Decodable, Equatable, Sendable {
    public enum Reason: String, Equatable, Sendable {
        case nothingAnswered = "nothing_answered", notOpen = "not_open", other
    }

    public let allowed: Bool
    public let reason: Reason?

    public init(allowed: Bool, reason: Reason?) {
        self.allowed = allowed
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey { case allowed, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        allowed = container.decodeLossyBoolIfPresent(forKey: .allowed) ?? false
        reason = container.decodeLossyStringIfPresent(forKey: .reason).map { Reason(rawValue: $0) ?? .other }
    }
}

/// TAL-1964: item ids per answers filter, in display order.
public struct DecisionFilters: Decodable, Equatable, Sendable {
    public let new: [String]
    public let pending: [String]

    public init(new: [String], pending: [String]) {
        self.new = new
        self.pending = pending
    }
}

/// A transcript card's review (`result_view.decision_review`) and a session's newest open review (`decision_review`).
public struct DecisionReviewRef: Decodable, Equatable, Hashable, Sendable {
    public let reviewId: String
    public let title: String
    public let progress: DecisionProgress

    public init(reviewId: String, title: String, progress: DecisionProgress) {
        self.reviewId = reviewId
        self.title = title
        self.progress = progress
    }
}

/// The `decision_review` session stream event, sent after each change to a review of that session.
public struct DecisionReviewEvent: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let reviewId: String
    public let status: DecisionReview.Status
    public let progress: DecisionProgress

    public init(sessionId: String, reviewId: String, status: DecisionReview.Status, progress: DecisionProgress) {
        self.sessionId = sessionId
        self.reviewId = reviewId
        self.status = status
        self.progress = progress
    }
}

/// `PUT /api/decisions/{review_id}/answers/{item_id}`. No choice, not deferred and not custom clears the stored answer.
/// `value` is always sent, as null when there is no choice.
public struct DecisionAnswerInput: Encodable, Equatable, Sendable {
    public let reviewId: String
    public let itemId: String
    public let value: String?
    public let notes: String
    public let deferred: Bool
    public let custom: Bool
    public let expectedVersion: Int
    public let contentHash: String

    public init(reviewId: String, itemId: String, value: String?, notes: String, deferred: Bool, custom: Bool, expectedVersion: Int, contentHash: String) {
        self.reviewId = reviewId
        self.itemId = itemId
        self.value = value
        self.notes = notes
        self.deferred = deferred
        self.custom = custom
        self.expectedVersion = expectedVersion
        self.contentHash = contentHash
    }

    enum CodingKeys: String, CodingKey {
        case reviewId, itemId, value, notes, deferred, custom, expectedVersion, contentHash
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(reviewId, forKey: .reviewId)
        try container.encode(itemId, forKey: .itemId)
        try container.encode(value, forKey: .value)
        try container.encode(notes, forKey: .notes)
        try container.encode(deferred, forKey: .deferred)
        try container.encode(custom, forKey: .custom)
        try container.encode(expectedVersion, forKey: .expectedVersion)
        try container.encode(contentHash, forKey: .contentHash)
    }

    var clears: Bool { value == nil && !deferred && !custom }
}
