import XCTest
@testable import TalariaKit

final class APIClientUpdatesApplyTests: APIClientTestCase {
    func testApplyUpdateRequestHitsEndpointWithWebuiTargetAndDecodesSuccess() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/updates/apply")

            // Confirm the body targets the webui repo (issue #180 scope).
            let body = apiTestBodyData(from: request)
            let decodedBody = try XCTUnwrap(body.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            })
            XCTAssertEqual(decodedBody["target"] as? String, "webui")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "message": "webui updated successfully",
              "target": "webui",
              "restart_scheduled": true
            }
            """, for: request)
        }

        let response = try await client.applyUpdate()

        XCTAssertEqual(response.ok, true)
        XCTAssertEqual(response.outcome, .applying)
    }

    func testServerRecoveryHandoffContinuesFollowingTheSameNotification() throws {
        let response = try decodeApply("""
        { "ok": false, "target": "agent", "recovery_pending": true,
          "notification_id": "00000000-0000-4000-8000-000000001523" }
        """)
        XCTAssertEqual(response.outcome, .applying)
        XCTAssertEqual(response.notificationId, "00000000-0000-4000-8000-000000001523")
    }

    func testAgentRefreshOfferIsNotTreatedAsFailure() throws {
        let response = try APIClient.responseDecoder().decode(
            UpdatesApplyResponse.self, from: sharedContractFixture("agent-update-refresh")
        )

        XCTAssertNotEqual(response.outcome, .failed, "The server is asking for consent to refresh its dashboards")
    }

    func testRestartBlockedResponseIsNotTreatedAsFailure() throws {
        let response = try decodeApply("""
        {
          "ok": false,
          "message": "Cannot update webui while 1 active chat stream is running. Wait for the response to finish, then retry the update.",
          "target": "webui",
          "restart_blocked": true,
          "active_streams": 1,
          "active_runs": 0
        }
        """)

        XCTAssertEqual(response.restartBlocked, true)
        XCTAssertEqual(response.outcome, .restartBlocked)
        XCTAssertTrue(response.displayMessage(default: "fallback").contains("active chat stream"))
    }

    func testWebInterruptDecodesTheSharedOfferAndRefusals() throws {
        let fixture = try XCTUnwrap(
            JSONSerialization.jsonObject(with: sharedContractFixture("web-update-interrupt")) as? [String: [String: Any]]
        )
        let offered = try XCTUnwrap(fixture["offered"])
        let wireOffer = try XCTUnwrap(offered["interrupt_confirmation"] as? [String: Any])
        let decoder = APIClient.responseDecoder()
        let offer = try decoder.decode(UpdatesApplyResponse.self, from: JSONSerialization.data(withJSONObject: offered))
        XCTAssertEqual(offer.outcome, .restartBlocked)
        XCTAssertEqual(offer.interruptConfirmation?.token, wireOffer["token"] as? String)
        XCTAssertEqual(offer.interruptConfirmation?.runs, wireOffer["runs"] as? Int)
        XCTAssertEqual(offer.interruptConfirmation?.expiresAt, wireOffer["expires_at"] as? String)

        for (key, outcome) in [("not_offered", UpdatesApplyResponse.Outcome.restartBlocked),
                               ("interrupt_failed", .failed), ("confirmed", .applying)] {
            let body = try XCTUnwrap(fixture[key])
            let response = try decoder.decode(UpdatesApplyResponse.self, from: JSONSerialization.data(withJSONObject: body))
            XCTAssertEqual(response.outcome, outcome, key)
            XCTAssertNil(response.interruptConfirmation, key)
            XCTAssertEqual(response.notificationId, body["notification_id"] as? String, key)
        }
    }

    func testNotOkResponsesAreFailed() throws {
        for json in [
            #"{ "ok": false, "message": "Update already in progress" }"#,
            #"{ "ok": false, "message": "The local webui repo has unresolved merge conflicts.", "conflict": true }"#,
            #"{ "ok": false, "message": "Fast-forward not possible.", "diverged": true }"#
        ] {
            XCTAssertEqual(try decodeApply(json).outcome, .failed, json)
        }
    }

    func testDisplayMessageFallsBackWhenMessageMissingOrBlank() throws {
        let missing = try decodeApply(#"{ "ok": false }"#)
        XCTAssertEqual(missing.displayMessage(default: "fallback"), "fallback")

        let blank = try decodeApply(#"{ "ok": false, "message": "   " }"#)
        XCTAssertEqual(blank.displayMessage(default: "fallback"), "fallback")

        let present = try decodeApply(#"{ "ok": false, "message": "  boom  " }"#)
        XCTAssertEqual(present.displayMessage(default: "fallback"), "boom")
    }

    func testTolerantDecodingIgnoresUnknownAndMissingFields() throws {
        // Unknown future keys and an otherwise-empty payload must not crash.
        let response = try decodeApply("""
        { "future_key": "ignored", "nested": { "anything": [1, 2, 3] } }
        """)

        XCTAssertNil(response.ok)
        XCTAssertNil(response.message)
        XCTAssertEqual(response.outcome, .failed)

        let malformed = try decodeApply(#"{"restart_blocked":true,"interrupt_confirmation":{"token":"bad","runs":0}}"#)
        XCTAssertEqual(malformed.outcome, .restartBlocked)
        XCTAssertNil(malformed.interruptConfirmation)
    }

    func testUpdateNotificationRequestsUseTypedRoutesAndDecodeServerCapabilities() async throws {
        let notification = """
        {
          "id": "00000000-0000-4000-8000-000000000001",
          "kind": "future_notice",
          "target": null,
          "phase": "attention",
          "severity": "critical",
          "persistent": true,
          "requires_acknowledgement": true,
          "actions": [{"id":"acknowledge","label":"Acknowledge","style":"primary","acknowledges":true}],
          "destination": {"key":"future.destination","label":"Open destination"},
          "title": "Action required",
          "message": "Review this notice.",
          "created_at": "2026-09-26T12:00:00Z",
          "updated_at": "2026-09-26T12:00:00Z",
          "read_at": null,
          "acknowledged_at": null,
          "acknowledged_action_id": null,
          "verified_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "verified_version": "web-v1.2.3",
          "unread": true,
          "active": false,
          "requires_interaction": true,
          "can_dismiss": false
        }
        """
        let client = makeClient { request in
            let path = try XCTUnwrap(request.url?.path)
            switch path {
            case "/api/update-notifications":
                XCTAssertEqual(request.httpMethod, "GET")
                return apiTestJSONResponse("""
                {"scope_id":"scope-a","notifications":[\(notification)],"unread_count":1,"clearable_count":0,"can_clear":false}
                """, for: request)
            case "/api/update-notifications/clear":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(try self.requestJSON(request)["clear"] as? Bool, true)
                return apiTestJSONResponse("""
                {"scope_id":"scope-a","notifications":[\(notification)],"unread_count":1,"clearable_count":0,"can_clear":false}
                """, for: request)
            case "/api/update-notifications/00000000-0000-4000-8000-000000000001/read":
                XCTAssertEqual(try self.requestJSON(request)["read"] as? Bool, true)
                return apiTestJSONResponse(notification.replacingOccurrences(of: "\"read_at\": null", with: "\"read_at\": \"2026-09-26T12:01:00Z\"").replacingOccurrences(of: "\"unread\": true", with: "\"unread\": false"), for: request)
            case "/api/update-notifications/00000000-0000-4000-8000-000000000001/dismiss":
                XCTAssertEqual(try self.requestJSON(request)["dismiss"] as? Bool, true)
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            case "/api/update-notifications/00000000-0000-4000-8000-000000000001/actions/acknowledge":
                XCTAssertEqual(try self.requestJSON(request)["perform"] as? Bool, true)
                return apiTestJSONResponse(notification.replacingOccurrences(of: "\"acknowledged_at\": null", with: "\"acknowledged_at\": \"2026-09-26T12:01:00Z\"").replacingOccurrences(of: "\"acknowledged_action_id\": null", with: "\"acknowledged_action_id\": \"acknowledge\"").replacingOccurrences(of: "\"requires_interaction\": true", with: "\"requires_interaction\": false").replacingOccurrences(of: "\"can_dismiss\": false", with: "\"can_dismiss\": true"), for: request)
            default:
                XCTFail("Unexpected path \(path)")
                return apiTestJSONResponse("{}", for: request)
            }
        }

        let listed = try await client.updateNotifications()
        XCTAssertEqual(listed.scopeId, "scope-a")
        XCTAssertEqual(listed.notifications.first?.kind, "future_notice")
        XCTAssertEqual(listed.notifications.first?.destination?.key, "future.destination")
        XCTAssertTrue(listed.notifications.first?.requiresInteraction == true)
        XCTAssertEqual(listed.notifications.first?.verifiedRevision, String(repeating: "a", count: 40))
        XCTAssertEqual(listed.notifications.first?.verifiedVersion, "web-v1.2.3")
        XCTAssertFalse(listed.canClear)
        let read = try await client.readUpdateNotification(id: "00000000-0000-4000-8000-000000000001")
        XCTAssertFalse(read.unread)
        let dismissed = try await client.dismissUpdateNotification(id: "00000000-0000-4000-8000-000000000001")
        XCTAssertTrue(dismissed.ok)
        let cleared = try await client.clearUpdateNotifications()
        XCTAssertFalse(cleared.canClear)
        let acted = try await client.performUpdateNotificationAction(id: "00000000-0000-4000-8000-000000000001", actionID: "acknowledge")
        XCTAssertEqual(acted.acknowledgedActionId, "acknowledge")
        XCTAssertTrue(acted.canDismiss)
    }

    func testSharedAgentWarningNotificationDecodes() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(UpdateNotificationsResponse.self, from: sharedContractFixture("update-notifications"))
        let warning = try XCTUnwrap(response.notifications.first { $0.kind == "agent_warning" })
        XCTAssertEqual(warning.target, "agent")
        XCTAssertEqual(warning.phase, "active")
        XCTAssertEqual(warning.severity, "warning")
        XCTAssertEqual(warning.title, "Agent warning")
        XCTAssertTrue(warning.message.contains("Home Assistant"))
        XCTAssertTrue(warning.persistent)
        XCTAssertTrue(warning.unread)
        XCTAssertTrue(warning.canDismiss)
        XCTAssertFalse(warning.requiresAcknowledgement)
        XCTAssertTrue(warning.actions.isEmpty)
        XCTAssertNil(warning.destination)
    }

    func testSharedRecoveringNotificationDecodesWithoutEndingTheUpdate() throws {
        let fixture = try sharedContractFixture("update-notifications")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(UpdateNotificationsResponse.self, from: fixture)
        let recovering = try XCTUnwrap(response.notifications.first { $0.phase == "recovering" })
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        let rows = try XCTUnwrap(payload["notifications"] as? [[String: Any]])
        let detail = try XCTUnwrap(rows.first { $0["id"] as? String == recovering.id }?["detail"] as? String)
        XCTAssertEqual(recovering.phase, "recovering")
        XCTAssertTrue(recovering.active)
        XCTAssertFalse(recovering.canDismiss)
        XCTAssertEqual(recovering.message, "Attempting recovery")
        XCTAssertEqual(recovering.detail, detail)
    }

    func testUpdateNotificationDecodesMultilineAndOmittedDetail() throws {
        let fixture = try sharedContractFixture("update-notifications")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        let rows = try XCTUnwrap(payload["notifications"] as? [[String: Any]])
        var row = try XCTUnwrap(rows.first { $0["phase"] as? String == "recovering" })
        let detail = "The gateway did not restart.\nCheck the service log."
        row["phase"] = "failed"
        row["detail"] = detail

        let decoder = APIClient.responseDecoder()
        let failed = try decoder.decode(UpdateNotificationRecord.self, from: JSONSerialization.data(withJSONObject: row))
        XCTAssertEqual(failed.detail, detail)

        row.removeValue(forKey: "detail")
        let older = try decoder.decode(UpdateNotificationRecord.self, from: JSONSerialization.data(withJSONObject: row))
        XCTAssertNil(older.detail)
    }

    func testUpdateNotificationTimestampAcceptsServerFractionalSeconds() {
        XCTAssertNotNil(UpdateNotificationTimestamp.date(from: "2026-09-26T12:00:00.123Z"))
        XCTAssertNotNil(UpdateNotificationTimestamp.date(from: "2026-09-26T12:00:00Z"))
        XCTAssertNil(UpdateNotificationTimestamp.date(from: "not-a-date"))
    }

    @MainActor
    func testMissingUpdateNotificationCapabilityStopsPollingUntilViewModelReplacement() async throws {
        for statusCode in [404, 405] {
            var requestCount = 0
            let client = makeClient { request in
                requestCount += 1
                return (
                    try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: statusCode, httpVersion: nil, headerFields: nil)),
                    Data()
                )
            }
            let viewModel = UpdateNotificationCenterViewModel(server: try XCTUnwrap(URL(string: "https://example.test")), client: client)

            await viewModel.refresh()
            await viewModel.refresh()

            XCTAssertEqual(requestCount, 1)
            XCTAssertNil(viewModel.lastError)
            XCTAssertFalse(viewModel.supportsNotifications)
        }

        var replacementRequests = 0
        let replacement = UpdateNotificationCenterViewModel(server: try XCTUnwrap(URL(string: "https://new.example.test")), client: makeClient { request in
            replacementRequests += 1
            return apiTestJSONResponse(#"{"scope_id":"replacement","notifications":[],"unread_count":0,"clearable_count":0,"can_clear":false}"#, for: request)
        })
        await replacement.refresh()
        XCTAssertEqual(replacementRequests, 1)
        XCTAssertNil(replacement.lastError)
        XCTAssertTrue(replacement.supportsNotifications)
    }

    /// TAL-1239: events and foregrounding carry fresh notices, so an idle active app asks at most once a minute.
    @MainActor
    func testActiveRefreshAsksAtMostOncePerMinuteAfterForeground() async throws {
        var requestCount = 0
        let viewModel = UpdateNotificationCenterViewModel(server: try XCTUnwrap(URL(string: "https://example.test")), client: makeClient { request in
            requestCount += 1
            return apiTestJSONResponse(#"{"notifications":[],"unread_count":0,"clearable_count":0,"can_clear":false}"#, for: request)
        })
        var elapsed = Duration.zero
        var requestsBeforeWaiting: Int?

        await viewModel.refreshWhileActive(
            sleep: { interval in
                if requestsBeforeWaiting == nil { requestsBeforeWaiting = requestCount }
                elapsed += interval
                if elapsed > .seconds(60) { throw CancellationError() }
            },
            onRefresh: {}
        )

        XCTAssertEqual(requestsBeforeWaiting, 1, "a foreground transition asks once before waiting")
        XCTAssertLessThanOrEqual(requestCount - 1, 1, "60 s of an idle active app asks at most once")
    }

    @MainActor
    func testAnOpenRecoverySurvivesReconnectUntilTheServerReportsSuccess() async throws {
        let shared = try XCTUnwrap(
            JSONSerialization.jsonObject(with: sharedContractFixture("update-notifications")) as? [String: Any]
        )
        let rows = try XCTUnwrap(shared["notifications"] as? [[String: Any]])
        let recovering = try XCTUnwrap(rows.first { $0["phase"] as? String == "recovering" })
        let finished = try XCTUnwrap(rows.first { $0["phase"] as? String == "succeeded" })
        let id = try XCTUnwrap(recovering["id"] as? String)
        var result = finished
        result["id"] = id
        result["target"] = recovering["target"]
        result["steps"] = [["id": "agent_ready", "label": "Hermes Agent 2.0.0 is running", "state": "done"]]
        let finalSteps = try XCTUnwrap(result["steps"] as? [[String: String]])
        func envelope(_ record: [String: Any]) throws -> String {
            var reply = shared
            reply["notifications"] = [record]
            reply["tab_update"] = NSNull()
            return String(decoding: try JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
        }
        let recoveringResponse = try envelope(recovering)
        let finishedResponse = try envelope(result)
        var polls = 0
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/update-notifications")
            polls += 1
            switch polls {
            case 1: return apiTestJSONResponse(recoveringResponse, for: request)
            case 2: throw URLError(.networkConnectionLost)
            default: return apiTestJSONResponse(finishedResponse, for: request)
            }
        }
        let model = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let tab = model.beginUpdate()
        await model.followUpdate(tabID: tab, notificationID: id)
        XCTAssertEqual(model.updating?.presentsDialog, true)
        await model.refresh()
        XCTAssertEqual(model.updating?.presentsDialog, true)
        XCTAssertFalse(model.updateTimedOut)
        await model.refresh()
        XCTAssertEqual(model.updating?.closeBehavior, .auto)
        XCTAssertEqual(model.updating?.steps?.map(\.label), finalSteps.compactMap { $0["label"] })
    }

    @MainActor
    func testDeferredGatewayRestartReopensWhenTheServerPresentsItAgain() async throws {
        let data = try sharedContractFixture("update-notifications")
        let shared = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(shared["notifications"] as? [[String: Any]])
        let waiting = try XCTUnwrap(rows.first { $0["phase"] as? String == "waiting_for_idle" })
        let id = try XCTUnwrap(waiting["id"] as? String)
        var restarting = waiting
        restarting["phase"] = "restarting"
        restarting["active"] = true
        restarting["presents_dialog"] = true
        restarting["dialog_close"] = "none"
        restarting["actions"] = []
        func envelope(_ record: [String: Any]) throws -> String {
            var reply = shared
            reply["notifications"] = [record]
            reply["tab_update"] = NSNull()
            return String(decoding: try JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
        }
        let response = LockedTestValue(try envelope(waiting))
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET", "Restart later changes only the local presentation")
            return apiTestJSONResponse(response.value, for: request)
        }
        let model = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)
        let tab = model.beginUpdate()
        await model.followUpdate(tabID: tab, notificationID: id)
        XCTAssertEqual(model.updating?.closeBehavior, .restartLater)

        model.closeUpdating()
        await model.refresh()
        XCTAssertNil(model.updating)

        response.value = try envelope(restarting)
        await model.refresh()
        XCTAssertEqual(model.updating?.id, id)
        XCTAssertEqual(model.updating?.closeBehavior, .some(.none))
    }

    @MainActor
    func testRestartNowUsesTheServerOfferedActionID() async throws {
        let fixture = try sharedContractFixture("update-notifications")
        let wire = try APIClient.responseDecoder().decode(UpdateNotificationsResponse.self, from: fixture)
        let waiting = try XCTUnwrap(wire.notifications.first { $0.phase == "waiting_for_idle" })
        let action = try XCTUnwrap(waiting.actions.first)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        let rows = try XCTUnwrap(raw["notifications"] as? [[String: Any]])
        let record = try XCTUnwrap(rows.first { $0["id"] as? String == waiting.id })
        let response = String(decoding: try JSONSerialization.data(withJSONObject: record), as: UTF8.self)
        let writes = LockedTestValue<[String]>([])
        let client = makeClient { request in
            if request.httpMethod == "GET" {
                XCTAssertEqual(request.url?.path, "/api/update-notifications")
                return apiTestJSONResponse(String(decoding: fixture, as: UTF8.self), for: request)
            }
            XCTAssertEqual(request.httpMethod, "POST")
            writes.value.append(try XCTUnwrap(request.url?.path))
            XCTAssertEqual(try self.requestJSON(request)["perform"] as? Bool, true)
            return apiTestJSONResponse(response, for: request)
        }
        let model = UpdateNotificationCenterViewModel(server: client.baseURL, client: client)

        await model.perform(action, for: waiting)

        XCTAssertEqual(writes.value, ["/api/update-notifications/\(waiting.id)/actions/\(action.id)"])
    }

    private func decodeApply(_ json: String) throws -> UpdatesApplyResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UpdatesApplyResponse.self, from: Data(json.utf8))
    }

    private func requestJSON(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(apiTestBodyData(from: request))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
