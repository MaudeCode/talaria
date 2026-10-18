import XCTest
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testModelSwitchRequiresAnAuthoritativeSuccessSession() async throws {
        for body in ["{}", #"{"session":{"session_id":"session-abc"}}"#, #"{"session":{"session_id":"foreign","model":"contributor"}}"#] {
            let model = try makeViewModel(sessionSummary: makeSession(model: "old-model", modelProvider: "custom")) { request in
                apiTestJSONResponse(body, for: request)
            }
            let applied = await model.selectComposerModel(ModelCatalogOption(id: "contributor", displayName: "Contributor", providerID: "custom"))
            XCTAssertFalse(applied)
            XCTAssertEqual(model.selectedModelID, "old-model", "An incomplete or foreign success must not apply the requested model as a fallback")
        }
    }

    func testModelGuardHoldIsNotAConfigurationFailure() async throws {
        for slash in [false, true] {
            let model = try makeViewModel(sessionSummary: makeSession(model: "old-model", modelProvider: "custom")) { request in
                XCTAssertEqual(request.url?.path, "/api/session/update")
                let response = HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error":"Confirm model change","type":"model_confirmation_required","warnings":[{"kind":"data_policy","title":"Data policy","model":"contributor","provider":"custom","message":"This model may use your conversation for training."}],"confirm_token":"opaque-token"}"#.utf8))
            }
            if slash {
                _ = await model.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "model")), args: "contributor")
            } else {
                _ = await model.selectComposerModel(ModelCatalogOption(id: "contributor", displayName: "Contributor", providerID: "custom"))
            }
            XCTAssertEqual(model.selectedModelID, "old-model")
            XCTAssertNil(model.composerConfigurationErrorMessage, "A held selection must ask for confirmation rather than report a failed model switch")
        }
    }

    func testModelConfirmationDecodesSharedWarningsAndRejectsMalformedRefusals() throws {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("model-confirmation")) as? [String: Any])
        let body = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["refusal"]))
        let refusal = try XCTUnwrap(APIError.http(statusCode: 409, body: String(decoding: body, as: UTF8.self)).modelConfirmationRequired)
        XCTAssertEqual(refusal.warnings.map(\.kind), ["data_policy", "context_cache"])
        XCTAssertEqual(refusal.warnings[0].title, "Data-Training Tier Warning")
        XCTAssertTrue(refusal.warnings[1].message.contains("200,000"))
        for mutation in [["type": "other"], ["confirm_token": ""], ["warnings": []]] as [[String: Any]] {
            let changed = try XCTUnwrap(fixture["refusal"] as? [String: Any]).merging(mutation) { _, new in new }
            let invalid = try JSONSerialization.data(withJSONObject: changed)
            XCTAssertNil(APIError.http(statusCode: 409, body: String(decoding: invalid, as: UTF8.self)).modelConfirmationRequired)
        }
        XCTAssertNil(APIError.http(statusCode: 200, body: String(decoding: body, as: UTF8.self)).modelConfirmationRequired)
    }

    func testModelConfirmationCancelExactRequestStaleContextAndFinalSession() async throws {
        for slash in [false, true] {
            var bodies: [[String: Any]] = []
            let model = try makeViewModel(sessionSummary: makeSession(model: "old-model", modelProvider: "custom")) { request in
                if request.url?.path == "/api/reasoning" { return apiTestJSONResponse("{}", for: request) }
                let body = try apiTestJSONBody(from: request)
                bodies.append(body)
                let token = body["confirm_token"] as? String
                // A concurrent turn/context change refreshes the server's decision.
                if token != "refreshed-token" {
                    return Self.modelHoldResponse(request, token: token == nil ? "initial-token" : "refreshed-token", kind: token == nil ? "data_policy" : "context_cache")
                }
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","model":"server-resolved","model_provider":"server-provider","model_option_id":"@server:resolved"}}"#, for: request)
            }
            let select = {
                if slash {
                    _ = await model.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "model")), args: "contributor")
                } else {
                    _ = await model.selectComposerModel(ModelCatalogOption(id: "contributor", displayName: "Contributor", providerID: "custom"))
                }
            }
            try await select()
            let cancelled = try XCTUnwrap(model.modelSwitchConfirmation)
            XCTAssertEqual(model.selectedModelID, "old-model")
            model.cancelModelSwitch()
            let cancelledApplied = await model.confirmModelSwitch(cancelled)
            XCTAssertFalse(cancelledApplied)
            XCTAssertEqual(bodies.count, 1)
            try await select()
            let initial = try XCTUnwrap(model.modelSwitchConfirmation)
            let initialApplied = await model.confirmModelSwitch(initial)
            XCTAssertFalse(initialApplied)
            XCTAssertEqual(model.selectedModelID, "old-model")
            let refreshed = try XCTUnwrap(model.modelSwitchConfirmation)
            XCTAssertEqual(refreshed.warnings[0].kind, "context_cache")
            XCTAssertNotEqual(initial.id, refreshed.id)
            let oldApplied = await model.confirmModelSwitch(initial)
            XCTAssertFalse(oldApplied)
            let finalApplied = await model.confirmModelSwitch(refreshed)
            XCTAssertTrue(finalApplied)
            XCTAssertEqual(model.selectedModelID, "server-resolved")
            XCTAssertEqual(model.selectedModelProviderID, "server-provider")
            XCTAssertNil(model.modelSwitchConfirmation)
            XCTAssertEqual(bodies.count, 4)
            for index in [2, 3] {
                var expected = bodies[1]
                expected["confirm_token"] = index == 2 ? "initial-token" : "refreshed-token"
                XCTAssertEqual(bodies[index] as NSDictionary, expected as NSDictionary)
            }
            let duplicateApplied = await model.confirmModelSwitch(refreshed)
            XCTAssertFalse(duplicateApplied)
            XCTAssertEqual(bodies.count, 4)
        }
    }

    func testModelConfirmationCannotCrossSessionServerOrNavigation() async throws {
        var requests = 0
        let handler: (URLRequest) throws -> (HTTPURLResponse, Data) = { request in
            requests += 1
            return Self.modelHoldResponse(request, token: "same-token", kind: "cost")
        }
        let first = try makeViewModel(handler: handler)
        _ = await first.selectComposerModel(ModelCatalogOption(id: "expensive", displayName: "Expensive", providerID: nil))
        let held = try XCTUnwrap(first.modelSwitchConfirmation)
        for other in [try makeViewModel(sessionSummary: SessionSummary(sessionId: "other-session"), handler: handler),
                      try makeViewModel(server: URL(string: "https://other.example.test")!, handler: handler)] {
            _ = await other.selectComposerModel(ModelCatalogOption(id: "expensive", displayName: "Expensive", providerID: nil))
            let count = requests
            let foreignApplied = await other.confirmModelSwitch(held)
            XCTAssertFalse(foreignApplied)
            XCTAssertEqual(requests, count)
        }
        first.suspendStreamForNavigation()
        let navigatedApplied = await first.confirmModelSwitch(held)
        XCTAssertFalse(navigatedApplied)
        XCTAssertNil(first.modelSwitchConfirmation)
    }

    func testModelConfirmationTransportFailurePreservesCurrentChoice() async throws {
        var updates = 0
        let model = try makeViewModel(sessionSummary: makeSession(model: "old-model", modelProvider: "custom")) { request in
            updates += 1
            if updates == 1 { return Self.modelHoldResponse(request, token: "token", kind: "new-server-kind") }
            throw URLError(.networkConnectionLost)
        }
        _ = await model.selectComposerModel(ModelCatalogOption(id: "target", displayName: "Target", providerID: nil))
        let confirmation = try XCTUnwrap(model.modelSwitchConfirmation)
        XCTAssertEqual(confirmation.warnings[0].kind, "new-server-kind")
        let applied = await model.confirmModelSwitch(confirmation)
        XCTAssertFalse(applied)
        XCTAssertEqual(model.selectedModelID, "old-model")
        XCTAssertEqual(model.selectedModelProviderID, "custom")
        XCTAssertNotNil(model.composerConfigurationErrorMessage)
        XCTAssertNil(model.modelSwitchConfirmation)
    }

    static func modelHoldResponse(_ request: URLRequest, token: String, kind: String) -> (HTTPURLResponse, Data) {
        let body: [String: Any] = ["error": "Confirm model change", "type": "model_confirmation_required", "confirm_token": token,
                                   "warnings": [["kind": kind, "title": "Server warning", "model": "target", "provider": "custom", "message": "Confirm this server decision."]]]
        return (HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!, try! JSONSerialization.data(withJSONObject: body))
    }
}
