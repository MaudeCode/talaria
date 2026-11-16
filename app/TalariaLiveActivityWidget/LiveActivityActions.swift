import AppIntents
import SwiftUI
import TalariaKit

/// TAL-1463: Allow or Deny from a Live Activity. The widget extension and the App both compile this file; the system
/// runs a `LiveActivityIntent` in the App's process, where the answer reuses `APIClient` and the Keychain.
struct RespondToApprovalIntent: LiveActivityIntent {
    enum Answer: String, AppEnum {
        case allow
        case deny

        static let typeDisplayRepresentation: TypeDisplayRepresentation = "Answer"
        static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.allow: "Allow", .deny: "Deny"]

        var choice: ApprovalChoice { self == .allow ? .once : .deny }
    }

    static let title: LocalizedStringResource = "Answer Approval"
    static let isDiscoverable = false

    /// The relay publisher (server origin) the run belongs to; nil for a run the App started without the relay.
    @Parameter(title: "Server") var publisherID: String?
    @Parameter(title: "Session") var sessionID: String
    /// The approval the activity shows; the answer is refused when another one is pending.
    @Parameter(title: "Approval") var approvalHeadID: String
    @Parameter(title: "Answer") var answer: Answer

    init() {}

    init(publisherID: String?, sessionID: String, approvalHeadID: String, answer: Answer) {
        self.publisherID = publisherID
        self.sessionID = sessionID
        self.approvalHeadID = approvalHeadID
        self.answer = answer
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !TALARIA_WIDGET_EXTENSION
        if answer == .deny {
            // TAL-1488: "Denied · Undo" for the window, then sent; the intent holds the process until then.
            await DeferredDenial.shared.deny(.init(
                publisherID: publisherID, sessionID: sessionID, approval: .head(approvalHeadID), fromBanner: false
            ))
        } else {
            await LiveActivityApprovalResponder.shared.respond(
                publisherID: publisherID, sessionID: sessionID, approval: .head(approvalHeadID), choice: answer.choice
            )
        }
        #endif
        return .result()
    }
}

/// TAL-1488: Undo beside a Live Activity's "Denied": the denial is never sent and the row waits for approval again.
struct UndoDenialIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Undo Deny"
    static let isDiscoverable = false

    @Parameter(title: "Server") var publisherID: String?
    @Parameter(title: "Session") var sessionID: String

    init() {}

    init(publisherID: String?, sessionID: String) {
        self.publisherID = publisherID
        self.sessionID = sessionID
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !TALARIA_WIDGET_EXTENSION
        await DeferredDenial.shared.undo(publisherID: publisherID, sessionID: sessionID)
        #endif
        return .result()
    }
}

/// What a waiting Live Activity row offers. An approval the activity names offers Deny and, when the activity also
/// shows what it runs, Allow; Open lands in the chat for an input request or any approval to review there. A stale row
/// keeps its buttons, since the server refuses an answer to an approval that is no longer the one shown; a finished run
/// offers nothing.
struct LiveActivityRowActions: Equatable {
    enum Kind: Equatable {
        /// `text` is what the approval runs; Relay never sends it, so a relay-driven row has none and offers no Allow.
        case approval(headID: String, text: String?)
        /// TAL-1488: Deny waits out its Undo window.
        case denying
        case open
    }

    let kind: Kind
    let sessionID: String
    let publisherID: String?

    init?(state: AgentRunActivityAttributes.ContentState, publisherID: String?) {
        guard !state.isFinal else { return nil }
        switch state.status {
        case .waitingForApproval where state.isDenying == true: kind = .denying
        case .waitingForApproval:
            kind = state.approvalHeadID.map { .approval(headID: $0, text: state.approvalText) } ?? .open
        case .waitingForClarification: kind = .open
        default: return nil
        }
        sessionID = state.sessionID
        self.publisherID = publisherID
    }

    init?(row: TalariaAggregateActivityAttributes.ContentState.Row) {
        switch row.phase {
        case "waiting_for_approval" where row.isDenying == true: kind = .denying
        case "waiting_for_approval": kind = row.approvalHeadId.map { .approval(headID: $0, text: nil) } ?? .open
        case "waiting_for_input": kind = .open
        default: return nil
        }
        sessionID = row.sessionId
        publisherID = row.publisherId
    }

    func intent(_ answer: RespondToApprovalIntent.Answer, headID: String) -> RespondToApprovalIntent {
        RespondToApprovalIntent(publisherID: publisherID, sessionID: sessionID, approvalHeadID: headID, answer: answer)
    }

    var undoIntent: UndoDenialIntent { UndoDenialIntent(publisherID: publisherID, sessionID: sessionID) }

    var openURL: URL? { TalariaDeepLink.sessionURL(sessionID: sessionID, publisherID: publisherID) }

    /// Aggregate rows that carry buttons: the first two waiting rows; the rest keep their row link.
    static let aggregateRowLimit = 2

    /// The first `limit` aggregate rows, each with its buttons when it carries them.
    static func aggregateRows(
        _ rows: [TalariaAggregateActivityAttributes.ContentState.Row], limit: Int
    ) -> [(row: TalariaAggregateActivityAttributes.ContentState.Row, actions: LiveActivityRowActions?)] {
        var remaining = aggregateRowLimit
        return rows.prefix(limit).map { row in
            let actions = remaining > 0 ? LiveActivityRowActions(row: row) : nil
            if actions != nil { remaining -= 1 }
            return (row, actions)
        }
    }
}

/// A waiting row's choices, with a refused answer's error above them. Allow sits below the whole text of what it
/// approves, which is never shortened: in a region too small for both, the bottom is cut first, so a visible Allow
/// always has its whole text above it.
struct LiveActivityActionButtons: View {
    @Environment(\.liveActivityPalette) private var palette
    let actions: LiveActivityRowActions
    var error: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error {
                LiveActivityAnswerError(text: error)
            }
            if actions.kind == .denying {
                // TAL-1488: "Denied · Undo" for Deny's window.
                buttons { titled in
                    Text("Denied")
                        .foregroundStyle(palette.secondaryText)
                        .lineLimit(1)
                    if titled {
                        Text(verbatim: "·")
                            .foregroundStyle(palette.secondaryText)
                            .accessibilityHidden(true)
                    }
                    Button(intent: actions.undoIntent) {
                        label("Undo", systemImage: "arrow.uturn.backward", titled: titled)
                    }
                    .buttonStyle(.bordered)
                }
            } else if case let .approval(_, text?) = actions.kind {
                Text(text)
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                buttons { titled in
                    allowButton(titled: titled)
                    denyButton(titled: titled)
                }
            } else {
                buttons { titled in
                    denyButton(titled: titled)
                    if let url = actions.openURL {
                        Link(destination: url) { label("Open", systemImage: "arrow.up.forward.app", titled: titled) }
                            .buttonStyle(.bordered)
                    }
                }
            }
        }
        .font(.caption.weight(.semibold))
        .tint(palette.actionTint)
    }

    /// Titles and symbols when they fit; otherwise, as in the Duo's vertical island, every button keeps its symbol.
    private func buttons(@ViewBuilder _ content: @escaping (Bool) -> some View) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { content(true) }.fixedSize()
            HStack(spacing: 8) { content(false) }.fixedSize()
        }
    }

    @ViewBuilder
    private func allowButton(titled: Bool) -> some View {
        if case let .approval(headID, _) = actions.kind {
            Button(intent: actions.intent(.allow, headID: headID)) {
                label("Allow", systemImage: "checkmark", titled: titled)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    private func denyButton(titled: Bool) -> some View {
        if case let .approval(headID, _) = actions.kind {
            Button(intent: actions.intent(.deny, headID: headID)) {
                label("Deny", systemImage: "xmark", titled: titled)
            }
            .buttonStyle(.bordered)
        }
    }

    @ViewBuilder
    private func label(_ title: LocalizedStringKey, systemImage: String, titled: Bool) -> some View {
        if titled {
            Label(title, systemImage: systemImage).lineLimit(1)
        } else {
            Label(title, systemImage: systemImage).labelStyle(.iconOnly)
        }
    }
}

/// Why an answer from the activity was refused, above the restored buttons.
struct LiveActivityAnswerError: View {
    @Environment(\.liveActivityPalette) private var palette
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(palette.color(for: .failed, isStale: false))
            .lineLimit(2)
    }
}
