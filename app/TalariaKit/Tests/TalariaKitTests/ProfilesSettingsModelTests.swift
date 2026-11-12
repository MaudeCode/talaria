import Foundation
import XCTest
@testable import TalariaKit

@MainActor
final class ProfilesSettingsModelTests: XCTestCase {
    private let row = #"{"name":"work","display_name":"Work Bot","description":"Original","is_default":false,"is_active":false}"#

    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> ProfilesSettingsModel {
        let host = "profiles-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        return ProfilesSettingsModel(client: APIClient(baseURL: URL(string: "https://\(host)")!,
                                                       session: URLSession(configuration: config)))
    }

    func testIdentityAndRemovalShowImmediatelyThenConfirmRollBackOrReconcileWithoutReplay() async throws {
        for deleting in [false, true] {
            for outcome in ["saved", "refused", "lost-saved", "lost-unsaved"] {
                let original = "{\"profiles\":[\(row)],\"active\":\"default\"}"
                let changedRow = row.replacingOccurrences(of: "Work Bot", with: "New Bot").replacingOccurrences(of: "Original", with: "New description")
                let changed = deleting ? #"{"profiles":[],"active":"default"}"# : "{\"profiles\":[\(changedRow)],\"active\":\"default\"}"
                let payload = LockedTestValue(original)
                let requests = DeferredRequests()
                let posted = expectation(description: "\(deleting)-\(outcome) write")
                let model = model { request in
                    if request.request.httpMethod == "POST" { _ = requests.append(request); posted.fulfill() }
                    else { request.complete(withJSON: payload.value) }
                }
                await model.load()
                let profile = try XCTUnwrap(model.profiles.first)
                let write = try XCTUnwrap(deleting ? model.delete(profile) : model.edit(profile, displayName: "New Bot", description: "New description"))
                XCTAssertEqual(model.profiles.count, deleting ? 0 : 1, "Deletion must remove the row before a response")
                if !deleting {
                    XCTAssertEqual(model.profiles.first?.displayName, "New Bot", "Editing must update before a response")
                    XCTAssertEqual(model.profiles.first?.description, "New description")
                }
                await fulfillment(of: [posted], timeout: 5)
                let request = requests.request(at: 0)
                XCTAssertEqual(request.request.url?.path, deleting ? "/api/profile/delete" : "/api/profile/update")
                let body = try JSONDecoder().decode([String: JSONValue].self, from: XCTUnwrap(apiTestBodyData(from: request.request)))
                XCTAssertEqual(body, deleting ? ["name": .string("work")] : ["name": .string("work"), "display_name": .string("New Bot"), "description": .string("New description")])
                if outcome == "saved" || outcome == "lost-saved" { payload.value = changed }
                switch outcome {
                case "saved": request.complete(withJSON: deleting ? #"{"ok":true,"name":"work"}"# : "{\"ok\":true,\"profile\":\(changedRow)}")
                case "refused": request.complete(withJSON: #"{"error":"Owner only"}"#, statusCode: 403)
                default: request.fail(with: URLError(.timedOut))
                }
                _ = await write.value
                let kept = outcome == "saved" || outcome == "lost-saved"
                XCTAssertEqual(model.profiles.count, deleting && kept ? 0 : 1)
                if !deleting { XCTAssertEqual(model.profiles.first?.displayName, kept ? "New Bot" : "Work Bot") }
                XCTAssertEqual(requests.count, 1, "A lost response must never replay the write")
                XCTAssertEqual(model.errorMessage == nil, outcome == "saved")
            }
        }
    }

    func testDeleteProtectionAndIdentityLimitsUseTheDecodedState() async throws {
        let posts = LockedTestValue(0)
        let model = model { request in
            if request.request.httpMethod == "POST" { posts.value += 1 }
            request.complete(withJSON: #"{"profiles":[{"name":"default","is_default":true},{"name":"active","is_active":true},{"name":"other-active"},{"name":"unknown","is_active":false},{"name":"work","is_default":false,"is_active":false,"display_name":"Bot title","display_name_overridden":true}],"active":"other-active"}"#)
        }
        await model.load()
        for profile in model.profiles.prefix(4) {
            XCTAssertFalse(model.canDelete(profile))
            XCTAssertNil(model.delete(profile))
        }
        let profile = try XCTUnwrap(model.profiles.last)
        XCTAssertTrue(model.canDelete(profile))
        XCTAssertNil(model.edit(profile, displayName: String(repeating: "x", count: 81), description: ""))
        XCTAssertNil(model.edit(profile, displayName: "", description: String(repeating: "x", count: 281)))
        XCTAssertNil(model.edit(profile, displayName: String(repeating: "e\u{301}", count: 41), description: ""), "Limits count Unicode code points, as the server does")
        XCTAssertNil(model.edit(profile, displayName: "", description: String(repeating: "e\u{301}", count: 141)))
        XCTAssertEqual(posts.value, 0)
    }

    func testQueuedEditsPreserveNewerChoicesAndOmitOverriddenName() async throws {
        let requests = DeferredRequests()
        let arrived = (0..<2).map { expectation(description: "write \($0)") }
        let model = model { request in
            if request.request.httpMethod == "POST" {
                let count = requests.append(request); arrived[count - 1].fulfill()
            } else {
                request.complete(withJSON: #"{"profiles":[{"name":"work","display_name":"Bot title","display_name_overridden":true,"description":"Original"}]}"#)
            }
        }
        await model.load()
        let profile = try XCTUnwrap(model.profiles.first)
        let first = try XCTUnwrap(model.edit(profile, displayName: "hidden", description: "First"))
        let second = try XCTUnwrap(model.edit(profile, displayName: "hidden too", description: "Second"))
        XCTAssertEqual(model.profiles.first?.displayName, "Bot title")
        XCTAssertEqual(model.profiles.first?.description, "Second")
        await fulfillment(of: [arrived[0]], timeout: 5)
        XCTAssertEqual(requests.count, 1)
        let body = try JSONDecoder().decode([String: JSONValue].self, from: XCTUnwrap(apiTestBodyData(from: requests.request(at: 0).request)))
        XCTAssertNil(body["display_name"], "Bot Mode's overridden name is never patched")
        requests.request(at: 0).complete(withJSON: #"{"ok":true,"profile":{"name":"work","display_name":"Bot title","description":"First","display_name_overridden":true}}"#)
        _ = await first.value
        XCTAssertEqual(model.profiles.first?.description, "Second", "An earlier response cannot overwrite the newer edit")
        await fulfillment(of: [arrived[1]], timeout: 5)
        requests.request(at: 1).complete(withJSON: #"{"error":"Refused"}"#, statusCode: 403)
        _ = await second.value
        XCTAssertEqual(model.profiles.first?.description, "First")
    }

    func testUseShowsImmediatelyRollsBackOnRefusalAndKeepsTheSwitchBotTip() async throws {
        for refused in [false, true] {
            let requests = DeferredRequests()
            let posted = expectation(description: "switch")
            let changed = LockedTestValue(false)
            let model = model { request in
                if request.request.httpMethod == "POST" { _ = requests.append(request); posted.fulfill() }
                else {
                    request.complete(withJSON: "{\"profiles\":[\(self.row)],\"active\":\"\(changed.value ? "work" : "default")\"}")
                }
            }
            await model.load()
            let write = try XCTUnwrap(model.use(try XCTUnwrap(model.profiles.first)))
            XCTAssertEqual(model.activeName, "work", "Use reflects the choice before the response")
            await fulfillment(of: [posted], timeout: 5)
            let request = requests.request(at: 0)
            XCTAssertEqual(request.request.url?.path, "/api/profile/switch")
            changed.value = !refused
            request.complete(withJSON: refused ? #"{"error":"Refused"}"# : #"{"active":"work","default_model":"chosen-model","profiles":[{"name":"work","canonical_session":{"session_id":"bot-root","tip_session_id":"bot-tip"}}]}"#, statusCode: refused ? 403 : 200)
            let response = await write.value
            XCTAssertEqual(model.activeName, refused ? "default" : "work")
            XCTAssertEqual(response?.profiles?.first?.canonicalSession?.tipSessionId, refused ? nil : "bot-tip", "Open Bot Chat uses the switch response's current tip")
            XCTAssertEqual(response?.defaultModel, refused ? nil : "chosen-model")
        }
    }

    func testUnresolvedDeletionSurvivesFailedReconciliationUntilRefresh() async throws {
        let online = LockedTestValue(true)
        let requests = DeferredRequests()
        let posted = expectation(description: "delete")
        let model = model { request in
            if request.request.httpMethod == "POST" { _ = requests.append(request); posted.fulfill() }
            else if online.value { request.complete(withJSON: "{\"profiles\":[\(self.row)]}") }
            else { request.fail(with: URLError(.notConnectedToInternet)) }
        }
        await model.load()
        let write = try XCTUnwrap(model.delete(try XCTUnwrap(model.profiles.first)))
        await fulfillment(of: [posted], timeout: 5)
        online.value = false
        requests.request(at: 0).fail(with: URLError(.timedOut))
        _ = await write.value
        XCTAssertTrue(model.profiles.isEmpty)
        online.value = true
        await model.load()
        XCTAssertEqual(model.profiles.first?.name, "work")
        XCTAssertEqual(requests.count, 1)
    }
}
