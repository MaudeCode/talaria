import SwiftUI
import TalariaKit

/// TAL-1965: a decision review the agent opened, pushed from its transcript card or the composer chip. Decide shows one
/// item at a time in the server's order; Answers lists every item with the server's filters, Continue's item and Submit.
struct DecisionReviewView: View {
    @State private var model: DecisionReviewModel
    @State private var showsSubmitReason = false
    @FocusState private var notesFocused: Bool
    let onAPIError: (Error) -> Void

    init(reviewID: String, server: URL, onAPIError: @escaping (Error) -> Void) {
        self.init(model: DecisionReviewModel(reviewID: reviewID, client: APIClient(baseURL: server)), onAPIError: onAPIError)
    }

    init(model: DecisionReviewModel, onAPIError: @escaping (Error) -> Void) {
        _model = State(initialValue: model)
        self.onAPIError = onAPIError
    }

    var body: some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.review != nil {
                    Picker(String(localized: "Decision review views"), selection: $model.page) {
                        Text(String(localized: "Decide")).tag(DecisionReviewModel.Page.decide)
                        Text(String(localized: "Answers")).tag(DecisionReviewModel.Page.answers)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .background(Color(.systemBackground))
                    .accessibilityIdentifier("decisions-tabs")
                }
            }
            .background(Color(.systemBackground))
            .navigationTitle(model.review?.title ?? String(localized: "Decision review"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .task { await model.load() }
            .onReceive(NotificationCenter.default.publisher(for: .talariaDecisionReviewChanged)) { notification in
                guard (notification.object as? DecisionReviewEvent)?.reviewId == model.reviewID else { return }
                Task { await model.load() }
            }
            .onChange(of: model.errorCount) {
                if let error = model.lastError { onAPIError(error) }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let review = model.review {
            List {
                switch model.page {
                case .decide: decideRows(review)
                case .answers: answerRows(review)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
        } else if let error = model.loadError {
            ContentUnavailableView {
                Label(String(localized: "Decision review unavailable"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(error.localizedDescription)
            } actions: {
                Button(String(localized: "Try Again")) { Task { await model.load() } }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Decide

    @ViewBuilder
    private func decideRows(_ review: DecisionReview) -> some View {
        if let item = model.currentItem, let index = model.currentIndex {
            let draft = model.draft(for: item)
            VStack(alignment: .leading, spacing: 6) {
                Text(String(localized: "\(index + 1) of \(review.items.count)"))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Text(item.title)
                    .font(.headline)
                if item.needsReview {
                    Text(String(localized: "This changed since you answered"))
                        .font(.footnote)
                        .foregroundStyle(.orange)
                } else if item.answer != nil {
                    Text(String(localized: "Your earlier answer is kept"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let refusal = model.refusal, refusal.itemID == item.id {
                    refusalText(refusal)
                }
            }
            .decisionRow()
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("decision-item-\(item.id)")

            VStack(alignment: .leading, spacing: 6) {
                Text(item.question)
                    .font(.subheadline.weight(.semibold))
                Text(item.explanation)
            }
            .decisionRow()
            if let example = item.example {
                block(String(localized: "For example"), example)
            }
            block(String(localized: "What happens today"), item.current)
            block(String(localized: "Recommendation"), item.recommendation)

            ForEach(item.choices) { choice in
                choiceRow(choice, item: item, draft: draft)
            }

            Button(String(localized: "Come back to this later")) {
                notesFocused = false
                Task { await model.deferCurrent() }
            }
            .disabled(!model.isOpen)
            .decisionRow()

            VStack(alignment: .leading, spacing: 8) {
                Text(String(localized: "Notes"))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                TextField(String(localized: "Notes"), text: notesBinding(for: item), axis: .vertical)
                    .lineLimit(2...8)
                    .focused($notesFocused)
                    .disabled(!model.isOpen)
                    .accessibilityIdentifier("decision-notes")
                Button(String(localized: "Use my notes as the answer")) {
                    notesFocused = false
                    Task { await model.useNotesForCurrent() }
                }
                .disabled(!model.isOpen || draft.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("decision-use-notes")
            }
            .buttonStyle(.borderless)
            .decisionRow()

            if item.technical.detail != nil || !item.technical.sources.isEmpty {
                DisclosureGroup(String(localized: "Technical details and sources")) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let detail = item.technical.detail {
                            Text(detail)
                                .font(.subheadline)
                                .textSelection(.enabled)
                        }
                        ForEach(item.technical.sources, id: \.self) { source in
                            if let url = URL(string: source), ["http", "https"].contains(url.scheme?.lowercased()) {
                                Link(source, destination: url)
                                    .font(.footnote)
                            } else {
                                Text(source)
                                    .font(.footnote.monospaced())
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .padding(.top, 6)
                }
                .decisionRow()
            }
        }
    }

    private func block(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
        }
        .decisionRow()
        .accessibilityElement(children: .combine)
    }

    private func choiceRow(_ choice: DecisionChoice, item: DecisionItem, draft: DecisionReviewModel.Draft) -> some View {
        let isSelected = draft.value == choice.value
        let isRecommended = choice.value == item.recommendedChoice
        return Button {
            model.setDraft(DecisionReviewModel.Draft(value: choice.value, notes: draft.notes), for: item)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(choice.label)
                            .font(.body.weight(.medium))
                            .foregroundStyle(isRecommended ? Color.accentColor : Color.primary)
                        if isRecommended {
                            StatusBadge(text: String(localized: "Recommended"), color: .accentColor)
                        }
                    }
                    Text(choice.effect)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!model.isOpen)
        .decisionRow()
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("decision-choice-\(item.id)-\(choice.value)")
    }

    private func refusalText(_ refusal: DecisionReviewModel.Refusal) -> some View {
        let text = switch refusal {
        case .conflict: String(localized: "This answer changed elsewhere. The saved answer is shown and your notes are kept.")
        case .changed: String(localized: "This decision changed. Read it again before you answer.")
        }
        return Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.orange)
            .accessibilityIdentifier("decision-refusal")
    }

    private func notesBinding(for item: DecisionItem) -> Binding<String> {
        Binding {
            model.draft(for: item).notes
        } set: { notes in
            var draft = model.draft(for: item)
            draft.notes = notes
            model.setDraft(draft, for: item)
        }
    }

    // MARK: Answers

    @ViewBuilder
    private func answerRows(_ review: DecisionReview) -> some View {
        let items = model.filteredItems
        if items.isEmpty {
            Text(String(localized: "Nothing to show"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .decisionRow()
        }
        ForEach(items) { item in
            answerRow(item)
        }
    }

    private func answerRow(_ item: DecisionItem) -> some View {
        Button {
            model.open(itemID: item.id)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.headline)
                    if item.answer?.deferred == true {
                        StatusBadge(text: String(localized: "Deferred"), color: .secondary)
                    }
                    if item.answer?.custom == true {
                        StatusBadge(text: String(localized: "Own answer"), color: .secondary)
                    }
                    if item.needsReview {
                        StatusBadge(text: String(localized: "Changed"), color: .orange)
                    }
                    Spacer(minLength: 8)
                    if let outcome = item.outcome {
                        Text(Self.outcomeLabel(outcome.state))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(answerText(item))
                    .font(.subheadline)
                    .foregroundStyle(item.answer?.label == nil && item.answer?.custom != true ? Color.secondary : Color.primary)
                if let note = item.outcome?.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .decisionRow()
        .accessibilityElement(children: .combine)
        .accessibilityHint(String(localized: "Opens this decision"))
        .accessibilityIdentifier("decision-item-row-\(item.id)")
        .swipeActions(edge: .trailing) {
            if model.isOpen, item.answer != nil {
                Button(String(localized: "Clear answer"), role: .destructive) {
                    Task { await model.clearAnswer(itemID: item.id) }
                }
            }
        }
        .contextMenu {
            Button {
                model.open(itemID: item.id)
            } label: {
                Label(String(localized: "Open"), systemImage: "arrow.right.circle")
            }
            Button(role: .destructive) {
                Task { await model.clearAnswer(itemID: item.id) }
            } label: {
                Label(String(localized: "Clear answer"), systemImage: "xmark.circle")
            }
            .disabled(!model.isOpen || item.answer == nil)
        }
    }

    private func answerText(_ item: DecisionItem) -> String {
        if let label = item.answer?.label { return label }
        if item.answer?.custom == true, let notes = item.answer?.notes { return notes }
        return String(localized: "No answer")
    }

    static func outcomeLabel(_ state: DecisionOutcome.State) -> String {
        switch state {
        case .applied: String(localized: "Applied")
        case .kept: String(localized: "Kept")
        case .blocked: String(localized: "Blocked")
        case .reviewed: String(localized: "Reviewed")
        case .planned: String(localized: "Planned")
        case .other: String(localized: "Recorded")
        }
    }

    static func filterLabel(_ filter: DecisionReviewModel.Filter) -> String {
        switch filter {
        case .all: String(localized: "All")
        case .new: String(localized: "New or changed")
        case .pending: String(localized: "Not answered")
        }
    }

    static func submitReason(_ reason: DecisionSubmit.Reason) -> String {
        switch reason {
        case .nothingAnswered: String(localized: "Answer a decision to submit")
        case .notOpen, .other: String(localized: "This review is closed")
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let review = model.review {
            switch model.page {
            case .decide:
                ToolbarItemGroup(placement: .bottomBar) {
                    Button(String(localized: "Back")) {
                        notesFocused = false
                        model.showPrevious()
                    }
                    .disabled((model.currentIndex ?? 0) == 0)
                    .accessibilityIdentifier("decision-back")
                    Spacer()
                    Button(String(localized: "Save & next")) {
                        notesFocused = false
                        Task { await model.saveAndNext() }
                    }
                    .bold()
                    .disabled(!model.isOpen || model.currentItem.map { model.draft(for: $0).value == nil } ?? true)
                    .accessibilityIdentifier("decision-save-next")
                }
            case .answers:
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker(String(localized: "Show"), selection: $model.filter) {
                            ForEach(DecisionReviewModel.Filter.allCases) { filter in
                                Text(Self.filterLabel(filter)).tag(filter)
                            }
                        }
                    } label: {
                        Label(String(localized: "Show"), systemImage: "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityIdentifier("decision-filter")
                }
                if let reason = review.submit.reason, !review.submit.allowed {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showsSubmitReason = true
                        } label: {
                            Label(String(localized: "Why Submit is unavailable"), systemImage: "info.circle")
                        }
                        .popover(isPresented: $showsSubmitReason) {
                            Text(Self.submitReason(reason))
                                .font(.subheadline)
                                .padding()
                                .presentationCompactAdaptation(.popover)
                        }
                        .accessibilityIdentifier("decision-submit-reason")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Submit")) {
                        Task { await model.submit() }
                    }
                    .bold()
                    .disabled(!review.submit.allowed)
                    .accessibilityIdentifier("decision-submit")
                }
                if review.status == .open, review.nextItemId != nil {
                    ToolbarItemGroup(placement: .bottomBar) {
                        Spacer()
                        Button(String(localized: "Continue")) { model.continueReview() }
                            .accessibilityIdentifier("decision-continue")
                    }
                }
            }
        }
    }
}

private extension View {
    /// The plain-list row of the design system: 10/20 insets on the system background.
    func decisionRow() -> some View {
        listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
            .listRowBackground(Color(.systemBackground))
    }
}

/// TAL-1965: the review a `decision_review_put` made, under its transcript row: title, status and progress, and Open,
/// which pushes the review screen. Nothing is answered here; the review's `decision_review` events reread it.
struct DecisionReviewResultSection: View {
    let reference: DecisionReviewRef
    @Environment(\.chatDecisionReviewLoader) private var loadReview
    @Environment(\.chatOpenDecisionReview) private var openReview
    @State private var review: DecisionReview?

    var body: some View {
        let progress = review?.progress ?? reference.progress
        let answered = String(localized: "\(progress.answered) of \(progress.total) answered")
        let status = review.map { "\(DecisionReviewResultSection.statusLabel($0.status)) · \(answered)" } ?? answered
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(review?.title ?? reference.title)
                    .font(AppFont.callout(weight: .semibold))
                Spacer(minLength: 6)
                Text(status)
                    .font(AppFont.caption())
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            if let openReview {
                Button(String(localized: "Open")) { openReview(reference.reviewId) }
                    .font(AppFont.callout(weight: .semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44, alignment: .leading)
                    .accessibilityLabel(String(localized: "Open decision review"))
                    .accessibilityIdentifier("decision-review-open-\(reference.reviewId)")
            }
        }
        .padding(.leading, 24)
        .task(id: reference.reviewId) { await reload() }
        .onReceive(NotificationCenter.default.publisher(for: .talariaDecisionReviewChanged)) { notification in
            guard (notification.object as? DecisionReviewEvent)?.reviewId == reference.reviewId else { return }
            Task { await reload() }
        }
    }

    private func reload() async {
        guard let loadReview else { return }
        if let loaded = try? await loadReview(reference.reviewId)() { review = loaded }
    }

    static func statusLabel(_ status: DecisionReview.Status) -> String {
        switch status {
        case .open: String(localized: "Open")
        case .submitted: String(localized: "Submitted")
        case .applied: String(localized: "Applied")
        case .cancelled: String(localized: "Cancelled")
        }
    }
}

/// TAL-1965: reads a transcript card's review; the chat screen supplies it for its session.
typealias ChatDecisionReviewLoader = ChatEnvironmentAction<String, @MainActor () async throws -> DecisionReview>
/// TAL-1965: pushes the review screen for a review id.
typealias ChatOpenDecisionReview = ChatEnvironmentAction<String, Void>

private struct ChatDecisionReviewLoaderKey: EnvironmentKey {
    static var defaultValue: ChatDecisionReviewLoader? { nil }
}

private struct ChatOpenDecisionReviewKey: EnvironmentKey {
    static var defaultValue: ChatOpenDecisionReview? { nil }
}

extension EnvironmentValues {
    var chatDecisionReviewLoader: ChatDecisionReviewLoader? {
        get { self[ChatDecisionReviewLoaderKey.self] }
        set { self[ChatDecisionReviewLoaderKey.self] = newValue }
    }

    var chatOpenDecisionReview: ChatOpenDecisionReview? {
        get { self[ChatOpenDecisionReviewKey.self] }
        set { self[ChatOpenDecisionReviewKey.self] = newValue }
    }
}
