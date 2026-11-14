import XCTest
import AppIntents
@testable import Talaria
@testable import TalariaKit

/// TAL-2233: Siri speaks the server's activity summary, and allows or denies a waiting approval by voice after reading
/// back what it runs.
@MainActor
final class AppIntentActivityTests: XCTestCase {
    private var originalMakeClient: (() -> APIClient?)!
    private var originalAppLock: AppLockModel!
    private var originalConfirm: ((RespondToApprovalByVoiceIntent, String) async throws -> Void)!
    private var confirmations: [String] = []

    override func setUp() async throws {
        try await super.setUp()
        originalMakeClient = TalariaStatusIntent.makeClient
        originalAppLock = TalariaStatusIntent.appLock
        originalConfirm = RespondToApprovalByVoiceIntent.confirm
        let lockName = "AppIntentActivityTests.\(UUID())"
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: lockName) }
        TalariaStatusIntent.appLock = AppLockModel(defaults: try XCTUnwrap(UserDefaults(suiteName: lockName)))
        RespondToApprovalByVoiceIntent.confirm = { [unowned self] _, command in confirmations.append(command) }
    }

    override func tearDown() async throws {
        TalariaStatusIntent.makeClient = originalMakeClient
        TalariaStatusIntent.appLock = originalAppLock
        RespondToApprovalByVoiceIntent.confirm = originalConfirm
        try await super.tearDown()
    }

    // MARK: - Status

    func testNoRowsSaysNothingIsRunning() async throws {
        serveSummary(waiting: [], running: [])
        XCTAssertFalse(TalariaStatusIntent.openAppWhenRun)

        let spoken = try await TalariaStatusIntent().perform().value

        XCTAssertEqual(spoken, "Nothing is running and nothing needs you.")
    }

    func testTwoWaitingAndTwoRunningAreNamedInServerOrder() async throws {
        serveSummary(
            waiting: [("Deploy fix", "waiting_for_approval"), ("Release notes", "waiting_for_input")],
            running: ["Refactor auth", "Nightly triage"]
        )

        let spoken = try await TalariaStatusIntent().perform().value

        XCTAssertEqual(
            spoken,
            "2 chats need you. Deploy fix: Approval needed. Release notes: Input needed. "
                + "2 chats are running: Refactor auth and Nightly triage."
        )
    }

    func testFiveWaitingNameTheFirstThreeAndCountTheRest() async throws {
        serveSummary(waiting: ["A", "B", "C", "D", "E"].map { ($0, "waiting_for_approval") }, running: [])

        let spoken = try await TalariaStatusIntent().perform().value

        XCTAssertEqual(
            spoken,
            "5 chats need you. A: Approval needed. B: Approval needed. C: Approval needed. And 2 more."
        )
    }

    // MARK: - Pending approvals

    func testApprovalQueryListsOnlyApprovalRowsInServerOrder() async throws {
        serveSummary(
            waiting: [("Deploy fix", "waiting_for_approval"), ("Release notes", "waiting_for_input"), ("Migrate", "waiting_for_approval")],
            running: ["Refactor auth"]
        )
        let query = PendingApprovalQuery()

        let suggested = try await query.suggestedEntities()
        XCTAssertEqual(suggested.map(\.title), ["Deploy fix", "Migrate"])
        XCTAssertEqual(suggested.map(\.id), ["s-Deploy fix", "s-Migrate"])

        let found = try await query.entities(for: ["s-Migrate", "s-Release notes"])
        XCTAssertEqual(found.map(\.title), ["Migrate"], "An input request is not an approval")
    }

    func testApprovalEntityIsPersonalOnIOS27() throws {
        guard #available(iOS 27, *) else { throw XCTSkip("Entity ownership needs iOS 27.") }
        let entity: Any = PendingApprovalEntity(id: "s1", title: "Deploy fix")
        let owned = try XCTUnwrap(entity as? any OwnershipProvidingEntity)
        XCTAssertEqual(owned.ownership, [])
    }

    // MARK: - Answering by voice

    func testConfirmedAnswersSendTheChoiceForTheApprovalReadBack() async throws {
        for (answer, choice) in [(RespondToApprovalIntent.Answer.allow, "once"), (.deny, "deny")] {
            let fixture = try answerFixture(pending: #"{"approval_id":"approval-s1","command":"rm -rf build"}"#)
            confirmations = []
            RespondToApprovalByVoiceIntent.confirm = { [unowned self] _, command in
                XCTAssertEqual(fixture.requests.value, [], "Confirmation comes before any answer")
                confirmations.append(command)
            }

            let spoken = try await voiceIntent(answer).perform().value

            XCTAssertEqual(confirmations, ["rm -rf build"])
            XCTAssertEqual(fixture.requests.value, [["session_id": "s1", "choice": choice, "approval_id": "approval-s1"]])
            XCTAssertEqual(spoken, answer == .allow ? "Allowed." : "Denied.")
        }
    }

    func testDecliningTheConfirmationSendsNothing() async throws {
        let fixture = try answerFixture(pending: #"{"approval_id":"approval-s1","command":"rm -rf build"}"#)
        RespondToApprovalByVoiceIntent.confirm = { _, _ in throw CancellationError() }

        _ = try? await voiceIntent(.allow).perform()

        XCTAssertEqual(fixture.requests.value, [])
    }

    func testAnApprovalWithoutTheChoiceOffersToOpenTheChat() async throws {
        let fixture = try answerFixture(pending: #"{"approval_id":"approval-s1","command":"deploy","allowed_choices":["deny"]}"#)

        let outcome = try await voiceIntent(.allow).respond()

        XCTAssertEqual(outcome, .openInApp("Open Talaria to answer this one.", TalariaDeepLink.sessionURL(sessionID: "s1")))
        XCTAssertEqual(confirmations, [])
        XCTAssertEqual(fixture.requests.value, [])
    }

    func testARefusedAnswerSpeaksTheServersError() async throws {
        let fixture = try answerFixture(
            pending: #"{"approval_id":"approval-s1","description":"Deploy to production"}"#,
            response: (403, #"{"error":"Only the owner can answer"}"#)
        )

        do {
            _ = try await voiceIntent(.allow).perform()
            XCTFail("A refused answer must not succeed")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The server refused the request: Only the owner can answer")
        }
        XCTAssertEqual(confirmations, ["Deploy to production"], "Without a command the description is read back")
        XCTAssertEqual(fixture.requests.value.count, 1)
    }

    // MARK: - Fixtures

    private func voiceIntent(_ answer: RespondToApprovalIntent.Answer) -> RespondToApprovalByVoiceIntent {
        RespondToApprovalByVoiceIntent(approval: PendingApprovalEntity(id: "s1", title: "Deploy fix"), answer: answer)
    }

    /// TAL-1463's responder spy: Siri reaches it through the active server, with no relay publisher.
    private func answerFixture(
        pending: String, response: (status: Int, body: String)? = nil
    ) throws -> ApprovalAnswerFixture {
        let fixture = try ApprovalAnswerFixture(
            responses: response.map { ["s1": $0] } ?? [:], pendingBodies: [#"{"pending":\#(pending)}"#], in: self
        )
        TalariaStatusIntent.makeClient = { fixture.client }
        return fixture
    }

    /// Waiting rows then running rows, in the order given, as `GET /api/activity/summary` serves them.
    private func serveSummary(waiting: [(title: String, phase: String)], running: [String]) {
        let rows: [[String: Any]] = (waiting + running.map { ($0, "running") }).map { title, phase in
            ["session_id": "s-\(title)", "title": title, "phase": phase, "started_at": 1, "updated_at": 2, "deep_link": "/sessions/s-\(title)"]
        }
        let summary: [String: Any] = ["waiting_count": waiting.count, "running_count": running.count, "rows": rows]
        let body = String(decoding: try! JSONSerialization.data(withJSONObject: summary), as: UTF8.self)
        let scope = MockURLProtocol.register { request in
            XCTAssertEqual(request.url?.path, "/api/activity/summary")
            return apiTestJSONResponse(body, for: request)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: scope]
        let client = APIClient(baseURL: URL(string: "https://status.example.test")!, session: URLSession(configuration: configuration))
        TalariaStatusIntent.makeClient = { client }
    }
}
