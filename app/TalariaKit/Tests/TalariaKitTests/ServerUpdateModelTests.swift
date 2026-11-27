import XCTest
@testable import TalariaKit

final class ServerUpdateModelTests: APIClientTestCase {
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
        let noSleep: @Sendable (Duration) async throws -> Void = { _ in }
        let model = ServerUpdateModel(client: client, follow: { id, tabID in
            await client.followUpdate(notificationID: id, tabID: tabID, sleep: noSleep)
        })
        let updating = Task { await model.apply() }
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
        XCTAssertEqual(model.status, .connected(version: "2.0.0-fixture"), "The completion must load the new version")

        restartRead.request(at: 0).fail(with: URLError(.networkConnectionLost))
        await refreshing.value
        XCTAssertEqual(model.status, .connected(version: "2.0.0-fixture"), "A restart-time read must not replace the new version")
        XCTAssertEqual(model.updateTargets?.webuiUpdateState, .upToDate)
    }

    @MainActor
    func testTimeoutReportsTheFreshSettingsFailureEvenWithAnOlderVersionInTheStore() async {
        let reachable = LockedTestValue(true)
        let client = deferredClient { request in
            switch request.request.url?.path {
            case "/api/updates/apply":
                reachable.value = false
                request.complete(withJSON: #"{"ok":true,"notification_id":"00000000-0000-4000-8000-000000000955"}"#)
            case "/api/settings" where reachable.value:
                request.complete(withJSON: #"{"webui_version":"1.0.0-fixture"}"#)
            case "/api/settings":
                request.complete(withJSON: #"{"error":"Restarting"}"#, statusCode: 503)
            case "/api/toolsets/defaults":
                request.complete(withJSON: #"{"toolsets":[],"selected_toolsets":[]}"#)
            case "/api/updates/check" where reachable.value:
                request.complete(withJSON: #"{"webui":{"state":"release_ready","can_apply":true,"behind":1}}"#)
            case "/api/updates/check":
                request.complete(withJSON: #"{"error":"Restarting"}"#, statusCode: 503)
            default:
                XCTFail("Unexpected request: \(request.request)")
                request.complete(withJSON: "{}", statusCode: 404)
            }
        }
        let store = ServerSettingsStore(client: client)
        let model = ServerUpdateModel(client: client, follow: { id, tabID in
            await client.followUpdate(notificationID: id, tabID: tabID, timeout: .zero)
        })
        await model.load(settingsStore: store)
        XCTAssertEqual(model.status, .connected(version: "1.0.0-fixture"))

        await model.apply(settingsStore: store)

        XCTAssertEqual(model.applyPhase, .failed(.timedOut(serverReachable: false)))
        XCTAssertEqual(model.status, .unavailable)
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
        let model = ServerUpdateModel(client: client)
        await model.apply()
        let first = try interruptOffer(in: model)
        let sent = Task { await model.apply(interrupting: first) }
        defer { sent.cancel() }
        try await pollUntil { confirmations.count == 1 }
        await model.apply(interrupting: first)
        XCTAssertEqual(confirmations.count, 1, "A repeat tap cannot send over the in-flight confirmation")
        XCTAssertEqual(fixture.body(for: confirmations.request(at: 0))["interrupt_token"], fixture.token)
        confirmations.request(at: 0).complete(withJSON: changed)
        await sent.value

        let refreshed = try interruptOffer(in: model)
        XCTAssertEqual(refreshed.token, replacementToken)
        await model.apply(interrupting: first)
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
        let model = ServerUpdateModel(client: client)
        let applying = Task { await model.apply() }
        defer { applying.cancel() }
        try await pollUntil { requests.count == 1 }
        model.discardInterruptConfirmation()
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
        let model = ServerUpdateModel(client: client)
        await model.apply()
        let confirmation = try interruptOffer(in: model)
        ActiveServerProfile.record("another-profile", for: client.baseURL)
        defer { ActiveServerProfile.record(nil, for: client.baseURL) }
        await model.apply(interrupting: confirmation)

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
        let noSleep: @Sendable (Duration) async throws -> Void = { _ in }
        let model = ServerUpdateModel(client: client, follow: { id, tabID in
            await client.followUpdate(notificationID: id, tabID: tabID, sleep: noSleep)
        })
        await model.apply()
        let consent = try interruptOffer(in: model)
        await model.apply(interrupting: consent)

        XCTAssertEqual(writes.value, ["", fixture.token])
        XCTAssertEqual(model.applyPhase, .idle)
        XCTAssertEqual(model.status, .connected(version: "2.0.0-fixture"))
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
