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
        await LiveActivityApprovalResponder.shared.respond(
            publisherID: publisherID, sessionID: sessionID, approvalHeadID: approvalHeadID, choice: answer.choice
        )
        #endif
        return .result()
    }
}

/// What a waiting Live Activity row offers: Allow and Deny answer in place the approval the server says the activity
/// shows, and Open lands in the chat for an input request or an approval the activity cannot name. A stale row keeps
/// its buttons, since the server refuses an answer to an approval that is no longer the one shown; a finished run
/// offers nothing.
struct LiveActivityRowActions: Equatable {
    enum Kind: Equatable {
        case approval(headID: String)
        case open
    }

    let kind: Kind
    let sessionID: String
    let publisherID: String?

    init?(status: AgentRunActivityStatus, approvalHeadID: String?, isFinal: Bool, sessionID: String, publisherID: String?) {
        guard !isFinal else { return nil }
        switch status {
        case .waitingForApproval: kind = approvalHeadID.map { .approval(headID: $0) } ?? .open
        case .waitingForClarification: kind = .open
        default: return nil
        }
        self.sessionID = sessionID
        self.publisherID = publisherID
    }

    init?(row: TalariaAggregateActivityAttributes.ContentState.Row) {
        switch row.phase {
        case "waiting_for_approval": kind = row.approvalHeadId.map { .approval(headID: $0) } ?? .open
        case "waiting_for_input": kind = .open
        default: return nil
        }
        sessionID = row.sessionId
        publisherID = row.publisherId
    }

    func intent(_ answer: RespondToApprovalIntent.Answer, headID: String) -> RespondToApprovalIntent {
        RespondToApprovalIntent(publisherID: publisherID, sessionID: sessionID, approvalHeadID: headID, answer: answer)
    }

    var openURL: URL? { TalariaDeepLink.sessionURL(sessionID: sessionID, publisherID: publisherID) }

    /// Aggregate rows that carry buttons: the first two waiting rows; the rest keep their row link.
    static let aggregateRowLimit = 2
}

struct LiveActivityActionButtons: View {
    let actions: LiveActivityRowActions

    /// Titles and symbols when they fit; otherwise, as in the Duo's vertical island, every button keeps its symbol.
    var body: some View {
        ViewThatFits(in: .horizontal) {
            buttons(titled: true)
            buttons(titled: false)
        }
        .font(.caption.weight(.semibold))
        .tint(AgentRunStatusStyle.color(for: .waitingForApproval, isStale: false))
    }

    private func buttons(titled: Bool) -> some View {
        HStack(spacing: 8) {
            switch actions.kind {
            case .approval(let headID):
                Button(intent: actions.intent(.allow, headID: headID)) {
                    label("Allow", systemImage: "checkmark", titled: titled)
                }
                .buttonStyle(.borderedProminent)
                Button(intent: actions.intent(.deny, headID: headID)) {
                    label("Deny", systemImage: "xmark", titled: titled)
                }
                .buttonStyle(.bordered)
            case .open:
                if let url = actions.openURL {
                    Link(destination: url) { label("Open", systemImage: "arrow.up.forward.app", titled: titled) }
                        .buttonStyle(.bordered)
                }
            }
        }
        .fixedSize()
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
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(AgentRunStatusStyle.color(for: .failed, isStale: false))
            .lineLimit(2)
    }
}
