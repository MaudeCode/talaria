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
        /// TAL-1488: Undo on the "Denied · Undo" banner.
        case undoDenial
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
        case PendingActionNotificationCategory.undoAction: request = .undoDenial
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
    /// chat to try again, with the reason, so an answer is never dropped silently. Deny is sent after its Undo window
    /// (TAL-1488) and reports the same way then.
    @MainActor
    func respond(with responder: LiveActivityApprovalResponder = .shared) async {
        let outcome: LiveActivityApprovalResponder.Outcome
        switch request {
        case let .approval(shown?, .deny):
            await DeferredDenial.shared.deny(.init(publisherID: publisherID, sessionID: sessionID, approval: shown, fromBanner: true))
            return
        case let .approval(shown?, choice):
            outcome = await responder.respond(publisherID: publisherID, sessionID: sessionID, approval: shown, choice: choice)
        case let .reply(question?, text):
            outcome = await responder.reply(publisherID: publisherID, sessionID: sessionID, question: question, text: text)
        case .undoDenial:
            await DeferredDenial.shared.undo(publisherID: publisherID, sessionID: sessionID)
            return
        case .approval(nil, _), .reply(nil, _):
            outcome = .refused(String(localized: "Open Talaria to answer this one."))
        }
        await Self.report(outcome, sessionID: sessionID, publisherID: publisherID)
    }

    @MainActor
    fileprivate static func report(_ outcome: LiveActivityApprovalResponder.Outcome, sessionID: String, publisherID: String?) async {
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
        await post(UNNotificationRequest(identifier: "answer-refused-\(sessionID)", content: content, trigger: nil))
    }
}

extension DeferredDenial.Record {
    init(publisherID: String?, sessionID: String, approval: LiveActivityApprovalResponder.ShownApproval, fromBanner: Bool) {
        let (headID, approvalID): (String?, String?) = switch approval {
        case let .head(id): (id, nil)
        case let .approval(id): (nil, id)
        }
        self.init(publisherID: publisherID, sessionID: sessionID, approvalHeadID: headID, approvalID: approvalID, fromBanner: fromBanner)
    }

    var approval: LiveActivityApprovalResponder.ShownApproval { approvalHeadID.map { .head($0) } ?? .approval(approvalID) }

    /// The "Denied · Undo" banner posted when no Live Activity shows the session; one per session.
    var undoNotificationID: String { "denied-\(key)" }

    var undoNotification: UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Denied · Undo")
        content.categoryIdentifier = PendingActionNotificationCategory.denied
        var userInfo = [SessionNotificationRefresh.sessionIDKey: sessionID]
        userInfo[SessionNotificationRefresh.publisherIDKey] = publisherID
        content.userInfo = userInfo
        return UNNotificationRequest(identifier: undoNotificationID, content: content, trigger: nil)
    }
}

extension DeferredDenial {
    /// TAL-1488: the Live Activity's Deny and the banner's Deny; tests substitute a clock and defaults.
    static var shared = DeferredDenial(effects: .app)
}

extension DeferredDenial.Effects {
    /// "Denied · Undo" on the session's Live Activity rows, or a banner when none shows it; the denial goes through the
    /// Live Activity's responder, so its rows settle and roll back as an instant answer's do.
    @MainActor static let app = Self(
        show: { record in
            let shown = await LiveActivityApprovalResponder.shared.showDenying(true, publisherID: record.publisherID, sessionID: record.sessionID)
            if !shown { await NotificationAnswer.post(record.undoNotification) }
        },
        restore: { record in
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [record.undoNotificationID])
            await LiveActivityApprovalResponder.shared.showDenying(false, publisherID: record.publisherID, sessionID: record.sessionID)
        },
        send: { record in
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [record.undoNotificationID])
            let outcome = await LiveActivityApprovalResponder.shared.respond(
                publisherID: record.publisherID, sessionID: record.sessionID, approval: record.approval, choice: .deny
            )
            // An activity shows its own refusal on the rows it rolled back.
            if case .refused = outcome, !record.fromBanner { return }
            await NotificationAnswer.report(outcome, sessionID: record.sessionID, publisherID: record.publisherID)
        }
    )
}
