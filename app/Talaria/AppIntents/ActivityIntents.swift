import AppIntents
import Foundation
import TalariaKit

/// "What's Talaria working on?" — speaks the server's activity summary without opening the app (TAL-2233): how many
/// chats need the user and how many are running, then their names in the server's order.
struct TalariaStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Talaria Status"
    static let description = IntentDescription("Hear which chats need you and which are running.")

    static let openAppWhenRun: Bool = false

    @available(iOS 26, *)
    static var supportedModes: IntentModes { .background }

    /// The saved server's client; tests substitute a fixture. The approval entity and voice answer use it too.
    @MainActor static var makeClient: () -> APIClient? = { AppIntentServer.saved()?.client() }
    /// App Lock guards chat titles too: a locked Talaria names nothing until it is unlocked in the app.
    @MainActor static var appLock = AppLockModel.shared

    /// Rows named per group; the rest are counted.
    static let namedLimit = 3

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let text = Self.dialog(for: try await Self.summary())
        return .result(value: text, dialog: "\(text)")
    }

    @MainActor
    static func summary() async throws -> ActivitySummary {
        guard !appLock.locksBackgroundWork() else {
            throw AskSession.Failure(message: String(localized: "Unlock Talaria in the app first."))
        }
        guard let client = makeClient() else {
            throw AskSession.Failure(message: String(localized: "Add a server in Talaria first."))
        }
        return try await client.activitySummary()
    }

    /// Waiting rows name their phase with the Live Activity's words; running and starting rows are listed by title.
    static func dialog(for summary: ActivitySummary) -> String {
        guard !summary.rows.isEmpty else { return String(localized: "Nothing is running and nothing needs you.") }
        let running = summary.rows.filter { ["running", "starting"].contains($0.phase) }
        let waiting = summary.rows.filter { !["running", "starting"].contains($0.phase) }
        var sentences: [String] = []
        if summary.waitingCount > 0 {
            sentences.append(String(localized: "\(summary.waitingCount) chats need you."))
            for row in waiting.prefix(namedLimit) {
                let phase = TalariaAggregateLiveActivityPresentation.accessibilityLabel(for: row.phase)
                sentences.append(String(localized: "\(row.title): \(phase)."))
            }
            let more = summary.waitingCount - min(waiting.count, namedLimit)
            if more > 0 { sentences.append(String(localized: "And \(more) more.")) }
        }
        if summary.runningCount > 0 {
            var names = running.prefix(namedLimit).map(\.title)
            let more = summary.runningCount - names.count
            if more > 0 { names.append(String(localized: "\(more) more")) }
            let list = ListFormatter.localizedString(byJoining: names)
            sentences.append(String(localized: "\(summary.runningCount) chats are running: \(list)."))
        }
        return sentences.joined(separator: " ")
    }
}

/// A chat waiting for an approval, as the server's activity summary lists it (TAL-2233).
struct PendingApprovalEntity: AppEntity, Identifiable {
    /// The chat's `session_id`.
    let id: String
    let title: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Approval")
    }

    static let defaultQuery = PendingApprovalQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

/// On a shared HomeView the system confirms before acting on a personal entity; `[]` is neither shared nor public.
@available(iOS 27, *)
extension PendingApprovalEntity: OwnershipProvidingEntity {
    var ownership: EntityOwnership { [] }
}

/// The summary's chats waiting for an approval, in the server's order; they are also the suggestions.
struct PendingApprovalQuery: EntityQuery {
    func entities(for identifiers: [PendingApprovalEntity.ID]) async throws -> [PendingApprovalEntity] {
        let waiting = try await suggestedEntities()
        return identifiers.compactMap { id in waiting.first { $0.id == id } }
    }

    func suggestedEntities() async throws -> [PendingApprovalEntity] {
        try await TalariaStatusIntent.summary().rows
            .filter { $0.phase == "waiting_for_approval" }
            .map { PendingApprovalEntity(id: $0.sessionId, title: $0.title) }
    }
}

/// "Approve the deploy fix in Talaria" — reads back what the approval runs, asks for confirmation, and answers through
/// the Live Activity's responder (TAL-1463), so the rows update the same way and nothing is sent unconfirmed.
struct RespondToApprovalByVoiceIntent: AppIntent, ForegroundContinuableIntent {
    static let title: LocalizedStringResource = "Answer Talaria Approval"
    static let description = IntentDescription("Allow or deny a command a Talaria chat is waiting on.")

    static let openAppWhenRun: Bool = false

    @Parameter(title: "Approval")
    var approval: PendingApprovalEntity

    @Parameter(title: "Answer")
    var answer: RespondToApprovalIntent.Answer

    init() {}

    init(approval: PendingApprovalEntity, answer: RespondToApprovalIntent.Answer) {
        self.approval = approval
        self.answer = answer
    }

    /// Asks the user to confirm the answer over what the approval runs; throws when they decline. Tests substitute it.
    @MainActor static var confirm: (RespondToApprovalByVoiceIntent, String) async throws -> Void = { intent, command in
        let dialog: IntentDialog = intent.answer == .allow ? "Allow \(command)?" : "Deny \(command)?"
        try await intent.requestConfirmation(dialog: dialog)
    }

    enum Outcome: Equatable {
        case spoken(String)
        /// The approval offers no answer Siri can give; the dialog offers to open the chat.
        case openInApp(String, URL?)
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        switch try await respond() {
        case let .spoken(text):
            return .result(value: text, dialog: "\(text)")
        case let .openInApp(text, url):
            throw needsToContinueInForegroundError("\(text)") { AppIntentRouter.shared.requestDeepLink(url) }
        }
    }

    @MainActor
    func respond() async throws -> Outcome {
        guard !TalariaStatusIntent.appLock.locksBackgroundWork() else {
            throw AskSession.Failure(message: String(localized: "Unlock Talaria in the app first."))
        }
        guard let client = TalariaStatusIntent.makeClient() else {
            throw AskSession.Failure(message: String(localized: "Add a server in Talaria first."))
        }
        guard let pending = try await client.approvalPending(sessionID: approval.id).pending else {
            return .spoken(String(localized: "\(approval.title) is no longer waiting for approval."))
        }
        guard pending.allows(answer.choice) else {
            return .openInApp(
                String(localized: "Open Talaria to answer this one."),
                TalariaDeepLink.sessionURL(sessionID: approval.id)
            )
        }
        try await Self.confirm(self, pending.command ?? pending.description ?? approval.title)
        if let error = await LiveActivityApprovalResponder.shared.respond(
            publisherID: nil, sessionID: approval.id, approval: .approval(pending.approvalId), choice: answer.choice
        ) {
            throw AskSession.Failure(message: error)
        }
        return .spoken(answer == .allow ? String(localized: "Allowed.") : String(localized: "Denied."))
    }
}
