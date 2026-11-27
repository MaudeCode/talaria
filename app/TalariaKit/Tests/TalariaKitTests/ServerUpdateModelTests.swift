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
        let model = ServerUpdateModel(client: client, follow: { id in
            await client.followUpdate(notificationID: id, sleep: noSleep)
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
        let model = ServerUpdateModel(client: client, follow: { id in
            await client.followUpdate(notificationID: id, timeout: .zero)
        })
        await model.load(settingsStore: store)
        XCTAssertEqual(model.status, .connected(version: "1.0.0-fixture"))

        await model.apply(settingsStore: store)

        XCTAssertEqual(model.applyPhase, .failed(.timedOut(serverReachable: false)))
        XCTAssertEqual(model.status, .unavailable)
    }
}
