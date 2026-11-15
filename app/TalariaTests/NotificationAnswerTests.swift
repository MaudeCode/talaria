import UserNotifications
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1469: Allow, Deny and Reply on a Talaria banner answer the request it showed without opening the app.
@MainActor
final class NotificationAnswerTests: XCTestCase {
    func testBannerCategoriesOfferAllowOnlyBesideTheApprovalText() async {
        let table = Dictionary(uniqueKeysWithValues: PendingActionNotificationCategory.all.map { category in
            (category.identifier, category.actions.map { "\($0.identifier):\($0.options.rawValue):\($0 is UNTextInputNotificationAction)" })
        })
        let allow = UNNotificationActionOptions.authenticationRequired.rawValue
        let deny = UNNotificationActionOptions([.authenticationRequired, .destructive]).rawValue
        XCTAssertEqual(table, [
            "talaria.approval": ["deny:\(deny):false"],
            "talaria.approval.allow": ["allow:\(allow):false", "deny:\(deny):false"],
            "talaria.input": ["reply:\(allow):true"],
        ])
        let registered = await UNUserNotificationCenter.current().notificationCategories()
        XCTAssertTrue(Set(table.keys).isSubset(of: registered.map(\.identifier)), "The App registers the categories at launch")
    }

    func testAllowOnTheBannerAnswersTheApprovalItShowedWithoutOpeningTheApp() async throws {
        let fixture = try ApprovalAnswerFixture(in: self)
        let response = try Self.response(action: "allow", userInfo: [
            "sessionId": "s1", "publisherId": ApprovalAnswerFixture.publisher, "approvalId": "approval-s1",
        ])
        let completed = expectation(description: "answer completion")
        let delegate: UNUserNotificationCenterDelegate = TalariaAppDelegate()
        delegate.userNotificationCenter?(.current(), didReceive: response) { completed.fulfill() }
        await fulfillment(of: [completed], timeout: 5)

        XCTAssertEqual(fixture.requests.value, [["session_id": "s1", "choice": "once", "approval_id": "approval-s1"]])
    }

    func testDenyAnswersOnlyTheHeadARelayBannerNamesAndNeverOpensTheChat() async throws {
        let fixture = try ApprovalAnswerFixture(in: self)
        let posted = postSpy()
        var opened: [URL] = []
        let deny = try XCTUnwrap(NotificationAnswer(actionIdentifier: "deny", userText: nil, userInfo: [
            "sessionId": "s1", "publisherId": ApprovalAnswerFixture.publisher, "approvalHeadId": "head-s1",
        ]))
        let url = TalariaDeepLink.sessionURL(sessionID: "s1", publisherID: ApprovalAnswerFixture.publisher)
        await TalariaAppDelegate.completeTap(opening: url, answering: deny, with: { opened.append($0) }) {}

        XCTAssertEqual(fixture.requests.value, [["session_id": "s1", "choice": "deny", "approval_id": "approval-s1"]])
        XCTAssertEqual(opened, [])
        XCTAssertEqual(posted.value, [])

        // A tap still opens the chat; it answers nothing.
        XCTAssertNil(NotificationAnswer(actionIdentifier: UNNotificationDefaultActionIdentifier, userText: nil, userInfo: ["sessionId": "s1"]))
    }

    func testARefusedAnswerPostsOneNotificationThatOpensTheChatToRetry() async throws {
        let fixture = try ApprovalAnswerFixture(responses: ["s1": (200, #"{"ok":false}"#)], in: self)
        let posted = postSpy()
        let userInfo = ["sessionId": "s1", "publisherId": ApprovalAnswerFixture.publisher, "approvalId": "approval-s1"]

        await NotificationAnswer(actionIdentifier: "allow", userText: nil, userInfo: userInfo)?.respond()
        // A banner that names no approval answers nothing.
        await NotificationAnswer(actionIdentifier: "deny", userText: nil, userInfo: ["sessionId": "s1"])?.respond()

        XCTAssertEqual(fixture.requests.value.count, 1)
        XCTAssertEqual(posted.value.map(\.content.title), ["Could not answer, open to retry", "Could not answer, open to retry"])
        XCTAssertEqual(posted.value.map(\.content.body), [
            "The server did not accept that response. The request is still waiting.", "Open Talaria to answer this one.",
        ])
        let retry = try XCTUnwrap(posted.value.first)
        XCTAssertEqual(retry.content.categoryIdentifier, "", "The retry opens the chat; it offers no answer of its own")
        XCTAssertEqual(
            SessionNotificationRefresh.sessionURL(userInfo: retry.content.userInfo),
            TalariaDeepLink.sessionURL(sessionID: "s1", publisherID: ApprovalAnswerFixture.publisher)
        )
    }

    /// Reply answers only the question its banner named, while that question is still the one pending.
    func testReplyAnswersOnlyTheQuestionItsBannerNamed() async throws {
        let question = #"{"pending":{"clarify_id":"c1","head_id":"head-c1","steps":[{"qid":"q0","question":"Which branch?","choices":["main"],"multi_select":false}]}}"#
        let pending = LockedTestValue(question)
        let sent = LockedTestValue<[String]>([])
        let responder = try replyResponder { request in
            switch request.url?.path {
            case "/api/clarify/pending": return apiTestJSONResponse(pending.value, for: request)
            case "/api/clarify/respond":
                sent.value.append(String(decoding: apiTestBodyData(from: request) ?? Data(), as: UTF8.self))
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            default:
                XCTFail("Unexpected request \(request.url?.path ?? "")")
                throw URLError(.badURL)
            }
        }
        let posted = postSpy()
        func reply(_ text: String, naming key: String, _ id: String) async throws {
            try await XCTUnwrap(NotificationAnswer(actionIdentifier: "reply", userText: text, userInfo: ["sessionId": "s1", key: id]))
                .respond(with: responder)
        }

        try await reply(" release ", naming: "clarifyId", "c1")
        try await reply("main", naming: "inputHeadId", "head-c1")
        // Another question pending, none pending, or several steps: nothing is sent.
        try await reply("release", naming: "inputHeadId", "head-other")
        pending.value = "{}"
        try await reply("release", naming: "clarifyId", "c1")
        pending.value = #"{"pending":{"clarify_id":"c2","head_id":"head-c2","steps":[{"qid":"a","question":"A","choices":[],"multi_select":false},{"qid":"b","question":"B","choices":[],"multi_select":false}]}}"#
        try await reply("both", naming: "clarifyId", "c2")
        // A banner that names no question answers nothing.
        try await XCTUnwrap(NotificationAnswer(actionIdentifier: "reply", userText: "hi", userInfo: ["sessionId": "s1"])).respond(with: responder)

        XCTAssertEqual(sent.value.count, 2, "\(sent.value)")
        for (body, answer) in zip(sent.value, ["release", "main"]) {
            XCTAssertTrue(body.contains(#""answers":{"q0":"\#(answer)"}"#), body)
            XCTAssertTrue(body.contains(#""clarify_id":"c1""#), body)
        }
        XCTAssertEqual(posted.value.map(\.content.body), [
            "This question changed. Open Talaria to answer it.", "This question changed. Open Talaria to answer it.",
            "Open Talaria to answer this one.", "Open Talaria to answer this one.",
        ])
    }

    /// The open chat's approval card goes on the refresh a successful banner answer posts.
    func testAllowOnTheBannerClearsTheOpenChatsApprovalCard() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-full"])
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Allow once")

        let allow = try XCTUnwrap(NotificationAnswer(actionIdentifier: "allow", userText: nil, userInfo: [
            "sessionId": UITestFixtureURLProtocol.sessionID, "approvalId": "ui-fixture-approval",
        ]))
        await allow.respond()

        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == "Allow once" }
        XCTAssertTrue(cleared, "The approval card stayed after the banner answered it")
    }

    private static func response(action: String, userInfo: [String: String]) throws -> UNNotificationResponse {
        let content = UNMutableNotificationContent()
        content.userInfo = userInfo
        let request = UNNotificationRequest(identifier: "banner", content: content, trigger: nil)
        let notification = try XCTUnwrap(UNNotification(coder: NotificationArchive(["request": request, "date": Date()])))
        return try XCTUnwrap(UNNotificationResponse(coder: NotificationArchive(["notification": notification, "actionIdentifier": action])))
    }

    private func postSpy() -> LockedTestValue<[UNNotificationRequest]> {
        let posted = LockedTestValue<[UNNotificationRequest]>([])
        let original = NotificationAnswer.post
        addTeardownBlock { @MainActor in NotificationAnswer.post = original }
        NotificationAnswer.post = { posted.value.append($0) }
        return posted
    }

    private func replyResponder(_ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)) throws -> LiveActivityApprovalResponder {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(handler)]
        let client = APIClient(baseURL: URL(string: ApprovalAnswerFixture.publisher)!, session: URLSession(configuration: configuration))
        let lockName = "NotificationAnswerTests.\(UUID())"
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: lockName) }
        return LiveActivityApprovalResponder(
            makeClient: { _ in client }, activeServer: { ApprovalAnswerFixture.publisher },
            appLock: AppLockModel(defaults: try XCTUnwrap(UserDefaults(suiteName: lockName))),
            display: .init(runs: { [] }, updateRun: { _, _ in }, aggregates: { [] }, updateAggregate: { _, _ in })
        )
    }
}
