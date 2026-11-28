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
            "talaria.denied": ["undo:0:false"],
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
        async let tap: Void = TalariaAppDelegate.completeTap(opening: url, answering: deny, with: { opened.append($0) }) {}
        // The session's Live Activity shows "Denied · Undo" for the window, so no Undo banner is posted.
        await fixture.clock.advance(by: DeferredDenial.window)
        await tap

        XCTAssertEqual(fixture.requests.value, [["session_id": "s1", "choice": "deny", "approval_id": "approval-s1"]])
        XCTAssertEqual(opened, [])
        XCTAssertEqual(posted.value, [])

        // A tap still opens the chat; it answers nothing.
        XCTAssertNil(NotificationAnswer(actionIdentifier: UNNotificationDefaultActionIdentifier, userText: nil, userInfo: ["sessionId": "s1"]))
    }

    /// TAL-1488: with no Live Activity showing the session, Deny posts one "Denied · Undo" banner; its Undo cancels the
    /// same denial, so nothing is sent.
    func testDenyWithoutALiveActivityPostsAnUndoBannerThatCancelsIt() async throws {
        let fixture = try ApprovalAnswerFixture(showsActivities: false, in: self)
        let posted = postSpy()
        let userInfo = ["sessionId": "s1", "publisherId": ApprovalAnswerFixture.publisher, "approvalHeadId": "head-s1"]

        async let deny: Void = XCTUnwrap(NotificationAnswer(actionIdentifier: "deny", userText: nil, userInfo: userInfo)).respond()
        let shown = await awaitCondition(timeout: 5) { !posted.value.isEmpty }
        XCTAssertTrue(shown)
        let banner = try XCTUnwrap(posted.value.first)
        XCTAssertEqual(banner.content.title, "Denied · Undo")
        XCTAssertEqual(banner.content.categoryIdentifier, "talaria.denied")
        let category = try XCTUnwrap(PendingActionNotificationCategory.all.first { $0.identifier == banner.content.categoryIdentifier })
        XCTAssertEqual(category.actions.map(\.identifier), ["undo"])

        let undo = try XCTUnwrap(NotificationAnswer(actionIdentifier: "undo", userText: nil, userInfo: banner.content.userInfo))
        await undo.respond()
        await fixture.clock.advance(by: DeferredDenial.window)
        try await deny

        XCTAssertEqual(fixture.requests.value, [], "The undone denial is never sent")
        XCTAssertEqual(posted.value.count, 1)
    }

    /// TAL-1488: a session whose aggregate row carries no buttons (it follows the first two waiting rows) shows no Undo
    /// there, so its Deny posts the Undo banner.
    func testDenyForAnAggregateRowWithoutButtonsPostsTheUndoBanner() async throws {
        let fixture = try ApprovalAnswerFixture(in: self)
        var third = fixture.aggregate.rows[1]
        third.sessionId = "s3"
        third.approvalHeadId = "head-s3"
        fixture.aggregate.rows.append(third)
        let posted = postSpy()
        let userInfo = ["sessionId": "s3", "publisherId": ApprovalAnswerFixture.publisher, "approvalHeadId": "head-s3"]

        async let deny: Void = XCTUnwrap(NotificationAnswer(actionIdentifier: "deny", userText: nil, userInfo: userInfo)).respond()
        let shown = await awaitCondition(timeout: 5) { !posted.value.isEmpty }
        XCTAssertTrue(shown, "Without a visible Undo on the activity, the banner offers it")
        XCTAssertEqual(posted.value.first?.content.title, "Denied · Undo")
        await fixture.clock.advance(by: DeferredDenial.window)
        try await deny

        XCTAssertEqual(fixture.requests.value, [["session_id": "s3", "choice": "deny", "approval_id": "approval-s3"]])
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

    /// Reply is an optimistic update with rollback: the session's input rows leave "Input" before the server answers, and
    /// a refused reply restores them with its error.
    func testReplySettlesTheInputRowsAtOnceAndRestoresThemWhenRefused() async throws {
        var run = AgentRunActivityStateReducer.waitingForClarification(
            state: AgentRunActivityStateReducer.initialState(sessionID: "s1", sessionTitle: "Deploy")
        )
        let waiting = run
        var aggregate = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 1, title: "Talaria", subtitle: "1 waiting", updatedAt: 0,
            rows: [.init(publisherId: ApprovalAnswerFixture.publisher, publisherLabel: "Home", sessionId: "s1", title: "Deploy",
                         phase: "waiting_for_input", status: "Input", updatedAt: 0, deepLink: "")]
        )
        let events = LockedTestValue<[String]>([])
        let question = #"{"pending":{"clarify_id":"c1","steps":[{"qid":"q0","question":"Which branch?","choices":[],"multi_select":false}]}}"#
        let responder = try replyResponder(display: .init(
            runs: { [.init(id: "run", publisherID: ApprovalAnswerFixture.publisher, state: run)] },
            updateRun: { _, state in run = state; events.value.append("run \(state.status.rawValue)") },
            aggregates: { [.init(id: "all", state: aggregate)] },
            updateAggregate: { _, state in aggregate = state; events.value.append("row \(state.rows[0].phase)") }
        )) { request in
            if request.url?.path == "/api/clarify/respond" { events.value.append("sent") }
            return apiTestJSONResponse(request.url?.path == "/api/clarify/pending" ? question : #"{"ok":true}"#, for: request)
        }
        _ = postSpy()

        let answered = await responder.reply(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", question: .clarify("c1"), text: "main")
        XCTAssertEqual(answered, .answered)
        XCTAssertEqual(events.value, ["run thinking", "row running", "sent"], "The rows left Input before the answer was sent")

        run = waiting
        aggregate.rows[0].phase = "waiting_for_input"
        let refused = await responder.reply(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", question: .clarify("other"), text: "main")
        XCTAssertEqual(refused, .refused("This question changed. Open Talaria to answer it."))
        XCTAssertEqual(run.status, .waitingForClarification)
        XCTAssertEqual(run.errorSummary, "This question changed. Open Talaria to answer it.")
        XCTAssertEqual(aggregate.rows[0].phase, "waiting_for_input")
        XCTAssertEqual(aggregate.answerError, "This question changed. Open Talaria to answer it.")
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

    private func replyResponder(
        display: LiveActivityApprovalResponder.Display = .init(runs: { [] }, updateRun: { _, _ in }, aggregates: { [] }, updateAggregate: { _, _ in }),
        _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) throws -> LiveActivityApprovalResponder {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(handler)]
        let client = APIClient(baseURL: URL(string: ApprovalAnswerFixture.publisher)!, session: URLSession(configuration: configuration))
        let lockName = "NotificationAnswerTests.\(UUID())"
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: lockName) }
        return LiveActivityApprovalResponder(
            makeClient: { _ in client }, activeServer: { ApprovalAnswerFixture.publisher },
            appLock: AppLockModel(defaults: try XCTUnwrap(UserDefaults(suiteName: lockName))),
            display: display
        )
    }

    // MARK: - Foreground presentation and taps (TAL-872, TAL-2224)

    private static let serverURL = URL(string: "https://example.test")!

    /// TAL-872: a chat on screen leaves quota alerts and other chats' notifications as they were.
    func testOnlyQuotaAlertsStayInNotificationCenterWhileForegrounded() throws {
        let quota = ProviderQuotaAlertService.request(.warning, sourceID: "qsrc_a", name: "Claude", remaining: nil, preferences: .init())
        let session = UNMutableNotificationContent()
        session.userInfo = [SessionNotificationRefresh.sessionIDKey: "session-1"]
        session.sound = .default
        let otherChat = try XCTUnwrap(SessionNotificationRefresh.VisibleChat(server: Self.serverURL, sessionID: "session-2"))

        for visibleChats: Set<SessionNotificationRefresh.VisibleChat> in [[], [otherChat]] {
            func presentation(_ content: UNNotificationContent) -> UNNotificationPresentationOptions {
                TalariaAppDelegate.foregroundPresentation(for: content, visibleChats: visibleChats)
            }
            XCTAssertEqual(presentation(quota.content), [.banner, .sound, .list])
            XCTAssertEqual(presentation(session), [.banner, .sound])
            XCTAssertEqual(presentation(UNMutableNotificationContent()), [.banner])
        }
    }

    func testSilentSessionNotificationKeepsItsBanner() {
        let content = UNMutableNotificationContent()
        content.userInfo = [SessionNotificationRefresh.sessionIDKey: "session-1"]

        XCTAssertEqual(TalariaAppDelegate.foregroundPresentation(for: content, visibleChats: []), [.banner])
    }

    func testForegroundBadgeOnlyPushCanClearTheBadgeWithoutABanner() {
        let content = UNMutableNotificationContent()
        content.badge = 0

        XCTAssertEqual(TalariaAppDelegate.foregroundPresentation(for: content, visibleChats: []), [.badge])
    }

    func testActivitySnapshotWritesTheUncappedServerCount() async throws {
        var counts: [Int] = []
        let (badge, client) = badgeFixture(waitingCount: 6, setCount: { counts.append($0) })

        _ = try await badge.snapshot(using: client)

        XCTAssertEqual(counts, [6])
    }

    func testBadgeRefreshClearsTheLastWaitingChat() async {
        var counts: [Int] = []
        let (badge, _) = badgeFixture(waitingCount: 0, setCount: { counts.append($0) })

        await badge.refresh()

        XCTAssertEqual(counts, [0])
    }

    func testActivitySnapshotSkipsTheBadgeWhenPermissionWasDeclined() async throws {
        let (badge, client) = badgeFixture(waitingCount: 1, allowed: false, setCount: { _ in
            XCTFail("The notification center must not receive a badge write when badges are disabled")
        })

        let snapshot = try await badge.snapshot(using: client)
        XCTAssertEqual(snapshot.waitingCount, 1)
    }

    private func badgeFixture(
        waitingCount: Int, allowed: Bool = true, setCount: @escaping (Int) -> Void
    ) -> (AppIconBadge, TalariaRelayClient) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register { request in
            XCTAssertEqual(request.url?.path, "/v1/activity-snapshot")
            let response = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil))
            return (response, Data(#"{"aggregate":null,"waitingCount":\#(waitingCount)}"#.utf8))
        }]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let credentials = TalariaRelayCredentials(
            baseURL: Self.serverURL, deviceID: "badge-device", userID: "badge-user",
            appleUserID: "badge-apple-user", sessionToken: "badge-token", expiresAt: .distantFuture
        )
        let client = TalariaRelayClient(credentials: credentials, session: session)
        let badge = AppIconBadge(
            currentCredentials: { credentials }, makeClient: { _ in client },
            badgeIsEnabled: { allowed }, setCount: setCount
        )
        return (badge, client)
    }

    /// TAL-872: the chat on screen already shows its own news, so its notification stays silent; the list still refreshes.
    func testNotificationForTheVisibleChatIsSilentButStillRefreshesTheList() async throws {
        let chat = try XCTUnwrap(SessionNotificationRefresh.VisibleChat(server: Self.serverURL, sessionID: "session-1"))
        let shown = SessionNotificationRefresh.ShownChat(chat, window: nil, isActive: true)
        SessionNotificationRefresh.updateVisibleChat(from: nil, to: shown)
        defer { SessionNotificationRefresh.updateVisibleChat(from: shown, to: nil) }
        let content = UNMutableNotificationContent()
        content.userInfo = [SessionNotificationRefresh.sessionIDKey: "session-1"]
        let request = UNNotificationRequest(identifier: "visible-chat", content: content, trigger: nil)
        // The delegate runs off the main actor; this test hands it the notification and never touches it again.
        nonisolated(unsafe) let notification = try XCTUnwrap(UNNotification(coder: NotificationArchive(["request": request, "date": Date()])))
        let refreshed = expectation(forNotification: .talariaSessionNotificationArrived, object: nil)

        let options = await TalariaAppDelegate().userNotificationCenter(.current(), willPresent: notification)

        await fulfillment(of: [refreshed], timeout: 5)
        XCTAssertEqual(options, [])
    }

    /// TAL-2224: UIKit snapshots the app when a tap's completion runs and asserts it is on main.
    func testTappedNotificationCompletesOnTheMainThread() async throws {
        let request = UNNotificationRequest(identifier: "tap", content: UNMutableNotificationContent(), trigger: nil)
        let notification = try XCTUnwrap(UNNotification(coder: NotificationArchive(["request": request, "date": Date()])))
        let response = try XCTUnwrap(UNNotificationResponse(coder: NotificationArchive([
            "notification": notification, "actionIdentifier": UNNotificationDefaultActionIdentifier,
        ])))
        let completed = expectation(description: "tap completion")
        let delegate: UNUserNotificationCenterDelegate = TalariaAppDelegate()
        delegate.userNotificationCenter?(.current(), didReceive: response) {
            XCTAssertTrue(Thread.isMainThread, "UIKit requires the tap completion on main")
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
    }

    func testTapCompletesAfterOpeningItsSession() async throws {
        let url = try XCTUnwrap(SessionNotificationRefresh.sessionURL(userInfo: [SessionNotificationRefresh.sessionIDKey: "session-1"]))
        var events: [String] = []
        let record = { (event: String) in events.append(Thread.isMainThread ? event : "\(event) off main") }

        await TalariaAppDelegate.completeTap(opening: url, with: { opened in
            await Task.yield()
            record("open \(opened.absoluteString)")
        }) { record("complete") }
        XCTAssertEqual(events, ["open \(url.absoluteString)", "complete"])

        events = []
        await TalariaAppDelegate.completeTap(opening: nil, with: { _ in record("open") }) { record("complete") }
        XCTAssertEqual(events, ["complete"], "a tap without a session completes without opening anything")
    }

    func testTappingTheRelayUpdateAlertOpensServerUpdateSettings() async throws {
        let fixture = try FixtureApp(for: self)
        let auth = fixture.environment.authManager
        let initial = try XCTUnwrap(auth.servers.first)
        let publisher = UITestFixtureEnvironment.secondServerURL
        let added = await auth.addServer(serverURLString: publisher.absoluteString, password: "")
        XCTAssertEqual(added, .added(publisher))
        auth.switchActiveServer(to: initial)
        let router = AppIntentRouter()
        let window = try hostWindow(fixture.root(intentRouter: router))
        _ = try await requireElement(in: window, label: "Select model")

        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("relay-server-notice-push")) as? [String: Any])
        var payload = try XCTUnwrap(wire["payload"] as? [String: Any])
        payload["publisherId"] = publisher.absoluteString
        let url = try XCTUnwrap(TalariaAppDelegate.notificationURL(userInfo: payload), "The Relay alert must have an app destination")
        await TalariaAppDelegate.completeTap(opening: url, with: { router.requestDeepLink($0) }) {}

        _ = try await requireElement(in: window, label: "Check for Updates")
        XCTAssertEqual(auth.state, .loggedIn(server: publisher))
        attachHostedScreenshot(window, name: "relay-update-alert-opens-system-settings")
    }
}

/// Decodes UserNotifications objects that have no public initializer from fixed key values.
final class NotificationArchive: NSCoder {
    private let values: [String: Any]
    init(_ values: [String: Any]) { self.values = values }
    override var allowsKeyedCoding: Bool { true }
    override func containsValue(forKey key: String) -> Bool { values[key] != nil }
    override func decodeObject(forKey key: String) -> Any? { values[key] }
    override func decodeBool(forKey key: String) -> Bool { false }
    override func decodeInteger(forKey key: String) -> Int { 0 }
    override func decodeInt64(forKey key: String) -> Int64 { 0 }
    override func decodeDouble(forKey key: String) -> Double { 0 }
}
