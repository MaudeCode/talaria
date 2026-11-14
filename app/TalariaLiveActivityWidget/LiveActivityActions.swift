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
    @Parameter(title: "Answer") var answer: Answer

    init() {}

    init(publisherID: String?, sessionID: String, answer: Answer) {
        self.publisherID = publisherID
        self.sessionID = sessionID
        self.answer = answer
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !TALARIA_WIDGET_EXTENSION
        await LiveActivityApprovalResponder.shared.respond(
            publisherID: publisherID, sessionID: sessionID, choice: answer.choice
        )
        #endif
        return .result()
    }
}

/// What a waiting Live Activity row offers: Allow and Deny answer in place, Open lands in the chat for an input
/// request. The phase comes from the server's row; a stale or finished row offers nothing.
struct LiveActivityRowActions: Equatable {
    enum Kind: Equatable {
        case approval
        case input
    }

    let kind: Kind
    let sessionID: String
    let publisherID: String?

    init?(status: AgentRunActivityStatus, isStale: Bool, isFinal: Bool, sessionID: String, publisherID: String?) {
        guard !isStale, !isFinal else { return nil }
        switch status {
        case .waitingForApproval: kind = .approval
        case .waitingForClarification: kind = .input
        default: return nil
        }
        self.sessionID = sessionID
        self.publisherID = publisherID
    }

    init?(row: TalariaAggregateActivityAttributes.ContentState.Row, isStale: Bool) {
        guard !isStale else { return nil }
        switch row.phase {
        case "waiting_for_approval": kind = .approval
        case "waiting_for_input": kind = .input
        default: return nil
        }
        sessionID = row.sessionId
        publisherID = row.publisherId
    }

    func intent(_ answer: RespondToApprovalIntent.Answer) -> RespondToApprovalIntent {
        RespondToApprovalIntent(publisherID: publisherID, sessionID: sessionID, answer: answer)
    }

    var openURL: URL? { TalariaDeepLink.sessionURL(sessionID: sessionID, publisherID: publisherID) }

    /// Aggregate rows that carry buttons: the first two waiting rows; the rest keep their row link.
    static let aggregateRowLimit = 2
}

struct LiveActivityActionButtons: View {
    let actions: LiveActivityRowActions

    var body: some View {
        HStack(spacing: 8) {
            switch actions.kind {
            case .approval:
                Button(intent: actions.intent(.allow)) { label("Allow", systemImage: "checkmark") }
                    .buttonStyle(.borderedProminent)
                Button(intent: actions.intent(.deny)) { label("Deny", systemImage: "xmark") }
                    .buttonStyle(.bordered)
            case .input:
                if let url = actions.openURL {
                    Link(destination: url) { label("Open", systemImage: "arrow.up.forward.app") }
                        .buttonStyle(.bordered)
                }
            }
        }
        .font(.caption.weight(.semibold))
        .tint(AgentRunStatusStyle.color(for: .waitingForApproval, isStale: false))
    }

    /// A narrow region, such as the Duo's vertical island, keeps the symbol alone.
    private func label(_ title: LocalizedStringKey, systemImage: String) -> some View {
        ViewThatFits(in: .horizontal) {
            Label(title, systemImage: systemImage).lineLimit(1)
            Label(title, systemImage: systemImage).labelStyle(.iconOnly)
        }
    }
}
