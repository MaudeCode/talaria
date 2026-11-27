import XCTest
@testable import TalariaKit

final class ServerUpdateModelTests: APIClientTestCase {
    @MainActor
    func testAgentRevisionConsentRetriesWithTheOfferedRevision() async throws {
        let revision = String(repeating: "b", count: 40)
        try await assertAgentConfirmationRetry(
            reply: Data(#"{"ok":false,"confirmation_required":true,"candidate_revision":"\#(revision)","message":"Install this revision?"}"#.utf8),
            field: "confirmed_agent_revision", value: revision
        )
    }

    @MainActor
    func testAgentDashboardRefreshRetriesWithTheOfferedToken() async throws {
        let reply = try sharedContractFixture("agent-update-refresh")
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
        let refresh = try XCTUnwrap(wire["refresh_confirmation"] as? [String: Any])
        try await assertAgentConfirmationRetry(reply: reply, field: "agent_refresh_token", value: XCTUnwrap(refresh["token"] as? String))
    }

    @MainActor
    func testAgentDashboardRefreshPreservesPreviouslyAcceptedRevision() async throws {
        let refreshReply = try sharedContractFixture("agent-update-refresh")
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: refreshReply) as? [String: Any])
        let revision = try XCTUnwrap(wire["candidate_revision"] as? String)
        let refresh = try XCTUnwrap(wire["refresh_confirmation"] as? [String: Any])
        let token = try XCTUnwrap(refresh["token"] as? String)
        let revisionReply = #"{"ok":false,"confirmation_required":true,"candidate_revision":"\#(revision)","message":"Install this revision?"}"#
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/updates/apply")
            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
            XCTAssertEqual(body["target"], "agent")
            if body["confirmed_agent_revision"] != revision {
                return apiTestJSONResponse(revisionReply, for: request)
            }
            if body["agent_refresh_token"] != token {
                return apiTestJSONResponse(String(decoding: refreshReply, as: UTF8.self), for: request)
            }
            return apiTestJSONResponse(#"{"ok":false,"message":"Reached the installation boundary"}"#, for: request)
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        await model.apply(target: .agent, notifications: notifications)
        guard case let .agentConfirmation(revisionOffer, _) = model.applyPhase, case .revision = revisionOffer else {
            return XCTFail("Expected revision consent")
        }
        await model.apply(target: .agent, confirming: revisionOffer, notifications: notifications)
        guard case let .agentConfirmation(refreshOffer, _) = model.applyPhase, case .refresh = refreshOffer else {
            return XCTFail("Expected dashboard refresh consent")
        }
        await model.apply(target: .agent, confirming: refreshOffer, notifications: notifications)

        XCTAssertEqual(model.applyPhase, .failed(.server(message: "Reached the installation boundary")))
    }

    @MainActor
    private func assertAgentConfirmationRetry(reply: Data, field: String, value: String) async throws {
        let writes = LockedTestValue<[[String: String]]>([])
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/updates/apply")
            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
            writes.value.append(body)
            let response = body[field] == nil ? String(decoding: reply, as: UTF8.self) : #"{"ok":false,"message":"Synthetic refusal"}"#
            return apiTestJSONResponse(response, for: request)
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        await model.apply(target: .agent, notifications: notifications)
        guard case let .agentConfirmation(confirmation, _) = model.applyPhase else { return XCTFail("Expected Agent consent") }
        await model.apply(target: .agent, confirming: confirmation, notifications: notifications)

        XCTAssertEqual(writes.value.map { $0["target"] }, ["agent", "agent"])
        XCTAssertEqual(writes.value.map { $0[field] }, [nil, value])
        let otherField = field == "confirmed_agent_revision" ? "agent_refresh_token" : "confirmed_agent_revision"
        XCTAssertEqual(writes.value.map { $0[otherField] }, [nil, nil])
    }

    @MainActor
    func testRestartRefreshCannotReplaceTheConnectedVersionAfterUpdate() async throws {
        let notificationID = "00000000-0000-4000-8000-000000000955"
        let notification = DeferredRequests()
        let restartRead = DeferredRequests()
        let restarting = LockedTestValue(true)
        let client = deferredClient { request in
            switch request.request.url?.path {
            case "/api/updates/apply":
                request.complete(withJSON: #"{"ok":true,"notification_id":"\#(notificationID)"}"#)
            case "/api/update-notifications":
                _ = notification.append(request)
            case "/api/settings" where restarting.value:
                _ = restartRead.append(request)
            case "/api/settings":
                request.complete(withJSON: #"{"webui_version":"2.0.0-fixture"}"#)
            case "/api/updates/check":
                request.complete(withJSON: #"{"webui":{"state":"up_to_date","current_version":"2.0.0-fixture"}}"#)
            default:
                XCTFail("Unexpected request: \(request.request)")
                request.complete(withJSON: "{}", statusCode: 404)
            }
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        let updating = Task { await model.apply(notifications: notifications) }
        defer { updating.cancel() }
        try await pollUntil { notification.count == 1 }
        guard notification.count == 1 else { return }

        let refreshing = Task { await model.load() }
        defer { refreshing.cancel() }
        try await pollUntil { restartRead.count == 1 }
        guard restartRead.count == 1 else { return }

        restarting.value = false
        notification.request(at: 0).complete(withJSON: """
        {"scope_id":"fixture","unread_count":0,"clearable_count":0,"can_clear":false,"notifications":[{
          "id":"\(notificationID)","kind":"update","target":"webui","phase":"succeeded","severity":"info",
          "persistent":false,"requires_acknowledgement":false,"actions":[],"title":"Update complete","message":"Updated",
          "created_at":"2026-11-27T12:00:00Z","updated_at":"2026-11-27T12:00:00Z","unread":false,"active":false,
          "requires_interaction":false,"can_dismiss":false
        }]}
        """)
        await updating.value
        notifications.closeUpdating()
        XCTAssertEqual(notifications.completedUpdateID, notificationID)
        await model.load(postUpdate: true)
        XCTAssertEqual(model.status, .connected(version: "2.0.0-fixture"), "The completion must load the new version")

        restartRead.request(at: 0).fail(with: URLError(.networkConnectionLost))
        await refreshing.value
        XCTAssertEqual(model.status, .connected(version: "2.0.0-fixture"), "A restart-time read must not replace the new version")
        XCTAssertEqual(model.updateTargets?.webuiUpdateState, .upToDate)
    }

    @MainActor
    func testUnverifiedUpdateOffersCloseAfterTheTrackingDeadline() async {
        let client = deferredClient { request in
            switch request.request.url?.path {
            case "/api/updates/apply":
                request.complete(withJSON: #"{"ok":true,"notification_id":"00000000-0000-4000-8000-000000000955"}"#)
            case "/api/update-notifications":
                request.complete(withJSON: #"{"scope_id":"fixture","notifications":[],"unread_count":0,"clearable_count":0,"can_clear":false}"#)
            default:
                XCTFail("Unexpected request: \(request.request)")
                request.complete(withJSON: "{}", statusCode: 404)
            }
        }
        var now = ContinuousClock.now
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client, now: { now })
        let model = ServerUpdateModel(client: client)
        await model.apply(notifications: notifications)
        XCTAssertTrue(notifications.isFollowingUpdate)
        XCTAssertFalse(notifications.updateTimedOut)

        now = now.advanced(by: .seconds(600))
        await notifications.refresh()

        XCTAssertFalse(notifications.isFollowingUpdate)
        XCTAssertTrue(notifications.updateTimedOut)
        notifications.closeUpdating()
        XCTAssertFalse(notifications.updateTimedOut)
    }

    @MainActor
    func testRenewedConsentRequiresTheNewTokenEvenAfterRapidRepeatTaps() async throws {
        let fixture = try InterruptFixture()
        let replacementToken = String(repeating: "e", count: 32)
        let changed = fixture.offer.replacingOccurrences(of: fixture.token, with: replacementToken)
        let confirmations = DeferredRequests()
        let client = deferredClient { request in
            switch request.request.url?.path {
            case "/api/updates/apply":
                let body = fixture.body(for: request)
                XCTAssertEqual(body["target"], "webui")
                if body["interrupt_token"] == nil {
                    request.complete(withJSON: fixture.offer)
                } else if confirmations.append(request) > 1 {
                    request.complete(withJSON: changed)
                }
            default: fixture.unexpected(request)
            }
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        await model.apply(notifications: notifications)
        let first = try interruptOffer(in: model)
        let sent = Task { await model.apply(interrupting: first, notifications: notifications) }
        defer { sent.cancel() }
        try await pollUntil { confirmations.count == 1 }
        await model.apply(interrupting: first, notifications: notifications)
        XCTAssertEqual(confirmations.count, 1, "A repeat tap cannot send over the in-flight confirmation")
        XCTAssertEqual(fixture.body(for: confirmations.request(at: 0))["interrupt_token"], fixture.token)
        confirmations.request(at: 0).complete(withJSON: changed)
        await sent.value

        let refreshed = try interruptOffer(in: model)
        XCTAssertEqual(refreshed.token, replacementToken)
        await model.apply(interrupting: first, notifications: notifications)
        XCTAssertEqual(confirmations.count, 1, "A consumed offer cannot be sent again")
        XCTAssertEqual(try interruptOffer(in: model), refreshed)
    }

    @MainActor
    func testDiscardingOnNavigationFencesAnInFlightOffer() async throws {
        let fixture = try InterruptFixture()
        let requests = DeferredRequests()
        let client = deferredClient { request in
            guard request.request.url?.path == "/api/updates/apply" else { return fixture.unexpected(request) }
            _ = requests.append(request)
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        let applying = Task { await model.apply(notifications: notifications) }
        defer { applying.cancel() }
        try await pollUntil { requests.count == 1 }
        model.discardConfirmation()
        requests.request(at: 0).complete(withJSON: fixture.offer)
        await applying.value

        XCTAssertEqual(model.applyPhase, .blocked(message: fixture.message))
    }

    @MainActor
    func testProfileSwitchInvalidatesAnAlreadyPresentedOffer() async throws {
        let fixture = try InterruptFixture()
        let writes = LockedTestValue(0)
        let client = deferredClient { request in
            guard request.request.url?.path == "/api/updates/apply" else { return fixture.unexpected(request) }
            writes.value += 1
            request.complete(withJSON: fixture.offer)
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        await model.apply(notifications: notifications)
        let confirmation = try interruptOffer(in: model)
        ActiveServerProfile.record("another-profile", for: client.baseURL)
        defer { ActiveServerProfile.record(nil, for: client.baseURL) }
        await model.apply(interrupting: confirmation, notifications: notifications)

        XCTAssertEqual(writes.value, 1)
        XCTAssertEqual(model.applyPhase, .blocked(message: fixture.message))
    }

    @MainActor
    func testLostConsentReplyReconcilesItsNotificationWithoutReapplying() async throws {
        let fixture = try InterruptFixture()
        let writes = LockedTestValue<[String]>([])
        let confirmationTab = LockedTestValue<String?>(nil)
        let client = deferredClient { request in
            switch request.request.url?.path {
            case "/api/updates/apply":
                let body = fixture.body(for: request)
                let token = body["interrupt_token"] ?? ""
                writes.value.append(token)
                if token.isEmpty {
                    request.complete(withJSON: fixture.offer)
                } else if writes.value.count > 2 {
                    XCTFail("An unknown confirmation outcome must not replay the write")
                    request.complete(withJSON: fixture.offer)
                } else {
                    confirmationTab.value = body["tab_id"]
                    request.fail(with: URLError(.networkConnectionLost))
                }
            case "/api/update-notifications":
                let query = request.request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }
                let tab = query?.first { $0.name == "tab_id" }?.value
                XCTAssertNotNil(tab)
                XCTAssertEqual(tab, confirmationTab.value)
                request.complete(withJSON: """
                {"scope_id":"fixture","unread_count":0,"clearable_count":0,"can_clear":false,"notifications":[],
                 "tab_update":{"id":"00000000-0000-4000-8000-000000000005","kind":"update","target":"webui","phase":"succeeded",
                 "severity":"info","persistent":false,"requires_acknowledgement":false,"actions":[],"title":"Update complete",
                 "message":"Updated","created_at":"2026-11-08T12:02:00.000Z","updated_at":"2026-11-08T12:02:00.000Z",
                 "unread":false,"active":false,"requires_interaction":false,"can_dismiss":false}}
                """)
            case "/api/settings":
                request.complete(withJSON: #"{"webui_version":"2.0.0-fixture"}"#)
            case "/api/updates/check":
                request.complete(withJSON: #"{"webui":{"state":"up_to_date","current_version":"2.0.0-fixture"}}"#)
            default: fixture.unexpected(request)
            }
        }
        let notifications = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let model = ServerUpdateModel(client: client)
        await model.apply(notifications: notifications)
        let consent = try interruptOffer(in: model)
        await model.apply(interrupting: consent, notifications: notifications)

        XCTAssertEqual(writes.value, ["", fixture.token])
        XCTAssertEqual(notifications.updating?.closeBehavior, .auto)
        XCTAssertEqual(notifications.updating?.id, "00000000-0000-4000-8000-000000000005")
    }

    @MainActor
    private func interruptOffer(in model: ServerUpdateModel) throws -> UpdatesApplyResponse.InterruptConfirmation {
        if case let .blocked(_, offer) = model.applyPhase { return try XCTUnwrap(offer) }
        return try XCTUnwrap(nil, "Expected an interrupt offer, got \(model.applyPhase)")
    }

    private struct InterruptFixture {
        let offer: String
        let token: String
        let message: String

        init() throws {
            let fixture = try XCTUnwrap(
                JSONSerialization.jsonObject(with: sharedContractFixture("web-update-interrupt")) as? [String: [String: Any]]
            )
            let offered = try XCTUnwrap(fixture["offered"])
            let confirmation = try XCTUnwrap(offered["interrupt_confirmation"] as? [String: Any])
            token = try XCTUnwrap(confirmation["token"] as? String)
            message = try XCTUnwrap(offered["message"] as? String)
            offer = String(decoding: try JSONSerialization.data(withJSONObject: offered), as: UTF8.self)
        }

        func body(for request: DeferredMockURLProtocol) -> [String: String] {
            let decoded = apiTestBodyData(from: request.request).flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: String]
            }
            XCTAssertNotNil(decoded)
            return decoded ?? [:]
        }

        func unexpected(_ request: DeferredMockURLProtocol) {
            XCTFail("Unexpected request: \(request.request)")
            request.complete(withJSON: "{}", statusCode: 404)
        }
    }
}
