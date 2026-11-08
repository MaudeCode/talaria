import Foundation
import Observation

/// TAL-1965: a decision review screen's state. `review` is the server's last copy with this user's unconfirmed saves laid
/// over it (root rule: optimistic writes). The order, progress, filters, Continue's item and Submit's state are the
/// server's; this model keeps only the shown item, the view, the filter and the typed drafts.
@MainActor
@Observable
public final class DecisionReviewModel {
    public enum Page: Hashable, Sendable { case decide, answers }

    public enum Filter: String, CaseIterable, Identifiable, Sendable {
        case all, new, pending
        public var id: String { rawValue }
    }

    /// A save the server refused because the stored answer or the item moved on; the item shows the stored answer.
    public enum Refusal: Equatable, Sendable {
        case conflict(itemID: String)
        case changed(itemID: String)

        public var itemID: String {
            switch self {
            case .conflict(let id), .changed(let id): id
            }
        }
    }

    /// What the user picked and typed for one item before saving it.
    public struct Draft: Equatable, Sendable {
        public var value: String?
        public var notes: String

        public init(value: String?, notes: String) {
            self.value = value
            self.notes = notes
        }
    }

    public let reviewID: String
    public private(set) var isLoading = false
    /// The last load's failure while no review is shown.
    public private(set) var loadError: Error?
    /// A failed write or submit, for the screen's existing error presentation; `errorCount` grows with each one.
    public private(set) var lastError: Error?
    public private(set) var errorCount = 0
    public private(set) var refusal: Refusal?
    public var page: Page = .decide
    public var filter: Filter = .all
    public private(set) var currentItemID: String?

    private var confirmed: DecisionReview?
    /// Unconfirmed saves by item: the answer shown (nil for a clear), its `answer_version`, and the save that set it.
    private var pendingAnswers: [String: (answer: DecisionAnswer?, version: Int, token: UUID)] = [:]
    /// Saves still waiting on the server or their reread; Submit waits for them.
    @ObservationIgnored private var saveRequests: [UUID: Task<Void, Never>] = [:]
    /// Saves whose outcome is unknown because their reread failed too: the shown answer stays until a read decides.
    private var unresolvedAnswers: [String: (token: UUID, input: DecisionAnswerInput, savedDraft: Draft?)] = [:]
    /// A submit whose outcome is unknown: it shows submitted until a read decides.
    private var submitUnresolved = false
    /// Saves that did not land as shown (refused, in conflict, or unresolved); a queued Submit stops when one fails.
    @ObservationIgnored private var failedSaves = 0
    private var pendingSubmit = false
    private var drafts: [String: Draft] = [:]
    @ObservationIgnored private let client: APIClient

    public init(reviewID: String, client: APIClient, review: DecisionReview? = nil) {
        self.reviewID = reviewID
        self.client = client
        confirmed = review
        currentItemID = review?.items.first?.id
    }

    /// The review as shown: the server's copy with this user's unconfirmed saves.
    public var review: DecisionReview? {
        guard var shown = confirmed else { return nil }
        if !pendingAnswers.isEmpty {
            shown.items = shown.items.map { item in
                guard let pending = pendingAnswers[item.id] else { return item }
                var item = item
                item.answer = pending.answer
                item.answerVersion = pending.version
                item.needsReview = false
                item.outcome = nil
                return item
            }
        }
        if pendingSubmit {
            shown = DecisionReview(
                reviewId: shown.reviewId, sessionId: shown.sessionId, title: shown.title, intro: shown.intro, status: .submitted,
                updatedAt: shown.updatedAt, progress: shown.progress, submit: DecisionSubmit(allowed: false, reason: .notOpen), items: shown.items,
                filters: shown.filters, nextItemId: shown.nextItemId
            )
        }
        return shown
    }

    public var isOpen: Bool { review?.status == .open }

    /// The item Decide shows: the chosen one, else the server's first.
    public var currentItem: DecisionItem? {
        guard let review else { return nil }
        return currentItemID.flatMap(review.item(id:)) ?? review.items.first
    }

    public var currentIndex: Int? {
        guard let review, let item = currentItem else { return nil }
        return review.items.firstIndex { $0.id == item.id }
    }

    /// The Answers rows for `filter`, in the server's order.
    public var filteredItems: [DecisionItem] {
        guard let review else { return [] }
        switch filter {
        case .all: return review.items
        case .new: return review.filters.new.compactMap(review.item(id:))
        case .pending: return review.filters.pending.compactMap(review.item(id:))
        }
    }

    public func draft(for item: DecisionItem) -> Draft {
        drafts[item.id] ?? Draft(value: item.answer?.value, notes: item.answer?.notes ?? "")
    }

    public func setDraft(_ draft: Draft, for item: DecisionItem) {
        drafts[item.id] = draft
    }

    public func open(itemID: String) {
        currentItemID = itemID
        page = .decide
    }

    /// Continue: the server's next item.
    public func continueReview() {
        guard let next = review?.nextItemId else { return }
        open(itemID: next)
    }

    public func showPrevious() {
        guard let review, let index = currentIndex, index > 0 else { return }
        currentItemID = review.items[index - 1].id
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            adopt(try await client.decisionReview(id: reviewID))
            loadError = nil
        } catch {
            guard !APIError.isCancellation(error) else { return }
            if confirmed == nil { loadError = error }
        }
    }

    /// "Save & next": an unchanged kept answer moves on without another write.
    public func saveAndNext() async {
        guard let item = currentItem else { return }
        let draft = draft(for: item)
        guard let value = draft.value else { return }
        let notes = draft.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if let answer = item.answer, !item.needsReview, !answer.deferred, !answer.custom, answer.value == value, answer.notes == notes {
            advance(from: item)
            return
        }
        await save(item, value: value, notes: draft.notes, deferred: false, custom: false)
    }

    /// Defer: saved without a choice, the notes kept.
    public func deferCurrent() async {
        guard let item = currentItem else { return }
        await save(item, value: nil, notes: draft(for: item).notes, deferred: true, custom: false)
    }

    /// "Use my notes as the answer"; refused locally while the notes are empty.
    public func useNotesForCurrent() async {
        guard let item = currentItem else { return }
        let notes = draft(for: item).notes
        guard !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        await save(item, value: nil, notes: notes, deferred: false, custom: true)
    }

    public func clearAnswer(itemID: String) async {
        guard let item = review?.item(id: itemID), item.answer != nil else { return }
        drafts[item.id] = nil
        await save(item, value: nil, notes: "", deferred: false, custom: false, advances: false)
    }

    /// Shows the review submitted at once; the request waits for every save still in flight, so the server hands the agent
    /// the answers as shown.
    public func submit() async {
        guard review?.submit.allowed == true, !pendingSubmit else { return }
        pendingSubmit = true
        lastError = nil
        let failuresBefore = failedSaves
        while let request = saveRequests.values.first { await request.value }
        // A save that did not land as shown stops the submit: the agent would act on answers the user never saw.
        guard failedSaves == failuresBefore, unresolvedAnswers.isEmpty, confirmed?.submit.allowed == true else {
            pendingSubmit = false
            return
        }
        do {
            let submitted = try await client.submitDecisionReview(id: reviewID)
            pendingSubmit = false
            adopt(submitted)
        } catch {
            guard !APIError.isCancellation(error) else {
                pendingSubmit = false
                return
            }
            if Self.isRefusal(error) {
                pendingSubmit = false
                report(error)
                _ = await reconcile()
                return
            }
            // Unknown outcome: the submitted look stays until a read shows whether the server took it.
            submitUnresolved = true
            if await reconcile() {
                if confirmed?.status == .open { report(error) }
            } else {
                report(error)
            }
        }
    }

    /// Shows `item` answered at once and moves on; a refusal restores the server's stored answer with the typed notes.
    private func save(_ item: DecisionItem, value: String?, notes: String, deferred: Bool, custom: Bool, advances: Bool = true) async {
        let input = DecisionAnswerInput(
            reviewId: reviewID, itemId: item.id, value: value, notes: notes, deferred: deferred, custom: custom,
            expectedVersion: item.answerVersion, contentHash: item.contentHash
        )
        let choice = item.choices.first { $0.value == value }
        let shown = input.clears ? nil : DecisionAnswer(
            value: choice?.value, label: choice?.label, effect: choice?.effect,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines), deferred: deferred, custom: custom, version: input.expectedVersion + 1
        )
        let token = UUID()
        pendingAnswers[item.id] = (shown, input.expectedVersion + 1, token)
        let savedDraft = drafts[item.id]
        if refusal?.itemID == item.id { refusal = nil }
        lastError = nil
        if advances { advance(from: item) }

        let request = Task { [weak self] in
            await self?.send(input, token: token, savedDraft: savedDraft)
            self?.saveRequests[token] = nil
        }
        saveRequests[token] = request
        await request.value
    }

    private func send(_ input: DecisionAnswerInput, token: UUID, savedDraft: Draft?) async {
        let itemID = input.itemId
        do {
            let saved = try await client.answerDecision(input)
            settle(itemID, token: token)
            adopt(saved)
            retire(savedDraft, of: itemID)
        } catch {
            guard !APIError.isCancellation(error) else {
                settle(itemID, token: token)
                return
            }
            failedSaves += 1
            if let stored = (error as? APIError)?.decisionStoredAnswer {
                settle(itemID, token: token)
                restore(itemID, stored: stored, notes: input.notes, code: (error as? APIError)?.serverCode)
                _ = await reconcile()
            } else if Self.isRefusal(error) {
                settle(itemID, token: token)
                report(error)
                _ = await reconcile()
            } else {
                // Unknown outcome: the shown answer stays until a server read decides whether the save landed; it is never
                // resent, and a failed reread leaves it unresolved rather than rolled back.
                unresolvedAnswers[itemID] = (token, input, savedDraft)
                if await reconcile(), Self.landed(input, in: confirmed?.item(id: itemID)) {
                    failedSaves -= 1
                } else {
                    report(error)
                }
            }
        }
    }

    /// A saved draft gives way to the server's answer, unless it was edited again since the save.
    private func retire(_ savedDraft: Draft?, of itemID: String) {
        if drafts[itemID] == savedDraft { drafts[itemID] = nil }
    }

    /// Rereads the review; false when the server could not be read.
    private func reconcile() async -> Bool {
        do {
            adopt(try await client.decisionReview(id: reviewID))
            return true
        } catch {
            return false
        }
    }

    private func report(_ error: Error) {
        lastError = error
        errorCount += 1
    }

    private func settle(_ itemID: String, token: UUID) {
        if pendingAnswers[itemID]?.token == token { pendingAnswers[itemID] = nil }
    }

    private func restore(_ itemID: String, stored: DecisionStoredAnswer, notes: String, code: String?) {
        guard var review = confirmed, let index = review.items.firstIndex(where: { $0.id == itemID }) else { return }
        review.items[index].answer = stored.answer
        review.items[index].answerVersion = stored.answerVersion
        confirmed = review
        drafts[itemID] = Draft(value: stored.answer?.value, notes: notes)
        refusal = code == "item_changed" ? .changed(itemID: itemID) : .conflict(itemID: itemID)
        currentItemID = itemID
        page = .decide
    }

    /// Takes the server's copy unless it is older than the one shown, so a read that started before a save cannot undo
    /// it. A read also settles every unresolved outcome.
    private func adopt(_ review: DecisionReview) {
        if let confirmed, review.updatedAt < confirmed.updatedAt { return }
        confirmed = review
        if currentItemID.flatMap(review.item(id:)) == nil { currentItemID = review.items.first?.id }
        for (itemID, unresolved) in unresolvedAnswers {
            settle(itemID, token: unresolved.token)
            if Self.landed(unresolved.input, in: review.item(id: itemID)) { retire(unresolved.savedDraft, of: itemID) }
        }
        unresolvedAnswers = [:]
        if submitUnresolved {
            submitUnresolved = false
            pendingSubmit = false
        }
    }

    /// The next item in the server's order, else the Answers list.
    private func advance(from item: DecisionItem) {
        guard let review, let index = review.items.firstIndex(where: { $0.id == item.id }) else { return }
        if index + 1 < review.items.count {
            currentItemID = review.items[index + 1].id
        } else {
            page = .answers
        }
    }

    /// Whether `item` holds this write: the version it would have made and the same answer, so another client's save at
    /// that version does not count as ours.
    static func landed(_ input: DecisionAnswerInput, in item: DecisionItem?) -> Bool {
        guard let item, item.answerVersion == input.expectedVersion + 1 else { return false }
        guard let answer = item.answer else { return input.clears }
        return !input.clears && answer.value == input.value && answer.deferred == input.deferred && answer.custom == input.custom
            && answer.notes == input.notes.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The server answered and refused: a 4xx other than a timeout. Anything else leaves the outcome unknown.
    static func isRefusal(_ error: Error) -> Bool {
        guard case .http(let status, _) = error as? APIError else { return false }
        return (400..<500).contains(status) && status != 408
    }
}
