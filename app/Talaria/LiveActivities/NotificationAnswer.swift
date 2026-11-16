import Foundation
import TalariaKit
import UserNotifications

/// TAL-1469: Allow, Deny or Reply chosen on a Talaria banner, answered without opening the app through the Live
/// Activity's responder, so its rows update the same way. The answer names only the request the banner showed.
struct NotificationAnswer: Equatable, Sendable {
    /// The approval or question the banner named; nil when it named none, and nothing is answered then.
    enum Request: Equatable, Sendable {
        case approval(LiveActivityApprovalResponder.ShownApproval?, ApprovalChoice)
        case reply(LiveActivityApprovalResponder.ShownQuestion?, String)
    }

    let request: Request
    let sessionID: String
    let publisherID: String?

    /// nil for a tap and any other action, which open the chat as before.
    init?(actionIdentifier: String, userText: String?, userInfo: [AnyHashable: Any]) {
        func value(_ key: String) -> String? {
            (userInfo[key] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        }
        guard let sessionID = value(SessionNotificationRefresh.sessionIDKey) else { return nil }
        let approval = value(PendingActionNotificationCategory.approvalHeadIDKey).map(LiveActivityApprovalResponder.ShownApproval.head)
            ?? value(PendingActionNotificationCategory.approvalIDKey).map { .approval($0) }
        let question = value(PendingActionNotificationCategory.inputHeadIDKey).map(LiveActivityApprovalResponder.ShownQuestion.head)
            ?? value(PendingActionNotificationCategory.clarifyIDKey).map(LiveActivityApprovalResponder.ShownQuestion.clarify)
        switch actionIdentifier {
        case PendingActionNotificationCategory.allowAction: request = .approval(approval, .once)
        case PendingActionNotificationCategory.denyAction: request = .approval(approval, .deny)
        case PendingActionNotificationCategory.replyAction: request = .reply(question, userText ?? "")
        default: return nil
        }
        self.sessionID = sessionID
        publisherID = value(SessionNotificationRefresh.publisherIDKey)
    }

    /// Where a refused answer is posted; tests substitute a spy.
    @MainActor static var post: (UNNotificationRequest) async -> Void = { request in
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// A success refreshes the list and the open chat at once. A refused answer posts one notification that opens the
    /// chat to try again, with the reason, so an answer is never dropped silently.
    @MainActor
    func respond(with responder: LiveActivityApprovalResponder = .shared) async {
        let outcome: LiveActivityApprovalResponder.Outcome
        switch request {
        case let .approval(shown?, choice):
            outcome = await responder.respond(publisherID: publisherID, sessionID: sessionID, approval: shown, choice: choice)
        case let .reply(question?, text):
            outcome = await responder.reply(publisherID: publisherID, sessionID: sessionID, question: question, text: text)
        case .approval(nil, _), .reply(nil, _):
            outcome = .refused(String(localized: "Open Talaria to answer this one."))
        }
        guard case let .refused(reason) = outcome else {
            NotificationCenter.default.post(name: .talariaSessionNotificationArrived, object: nil)
            return
        }
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Could not answer, open to retry")
        content.body = reason
        content.sound = .default
        var userInfo = [SessionNotificationRefresh.sessionIDKey: sessionID]
        userInfo[SessionNotificationRefresh.publisherIDKey] = publisherID
        content.userInfo = userInfo
        // One per chat: a second refusal replaces the first.
        await Self.post(UNNotificationRequest(identifier: "answer-refused-\(sessionID)", content: content, trigger: nil))
    }
}
