import Foundation
import XCTest
@testable import TalariaKit

@MainActor
final class ModelsSettingsViewModelTests: XCTestCase {
    private static func status(effort: String = "medium", thinking: Bool = true,
                               supportsEffort: Bool = true, supportsThinking: Bool = true,
                               efforts: [String] = ["low", "medium", "ultra"]) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: [
            "reasoning_effort": effort, "show_reasoning": thinking,
            "supports_reasoning_effort": supportsEffort, "supports_thinking_toggle": supportsThinking,
            "supported_efforts": efforts
        ]), as: UTF8.self)
    }

    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> ModelsSettingsViewModel {
        let host = "models-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config))
        return ModelsSettingsViewModel(client: client)
    }

    func testLoadAndModelChangeUseOnlyTheServerCapabilitiesAndVocabulary() async {
        let response = LockedTestValue(Self.status(supportsThinking: false))
        let defaultModel = LockedTestValue("fixture-model")
        let model = model { request in
            XCTAssertEqual(request.request.httpMethod, "GET")
            XCTAssertNil(request.request.url?.query)
            request.complete(withJSON: request.request.url?.path == "/api/models"
                ? #"{"default_model":"\#(defaultModel.value)"}"# : response.value)
        }
        await model.load()
        XCTAssertEqual(model.defaultModel, "fixture-model")
        XCTAssertTrue(model.showsReasoningEffort)
        XCTAssertFalse(model.showsThinkingToggle)
        XCTAssertEqual(model.supportedEfforts, ["low", "medium", "ultra"])
        XCTAssertEqual(model.reasoningEffort, "medium")
        XCTAssertTrue(model.showThinking)

        response.value = Self.status(effort: "", thinking: false, supportsEffort: false,
                                     supportsThinking: true, efforts: [])
        defaultModel.value = "other-model"
        await model.defaultModelChanged("other-model")
        XCTAssertEqual(model.defaultModel, "other-model")
        XCTAssertFalse(model.showsReasoningEffort)
        XCTAssertTrue(model.showsThinkingToggle)
        XCTAssertEqual(model.supportedEfforts, [])
        XCTAssertEqual(model.reasoningEffort, "")
        XCTAssertFalse(model.showThinking)
    }

    func testWritesShowAtOnceAndSerializeWithoutLosingTheLatestChoice() async throws {
        let writes = DeferredRequests()
        let serverStatus = LockedTestValue(Self.status())
        let refreshing = LockedTestValue(false)
        let first = expectation(description: "first write held")
        let second = expectation(description: "second write held")
        let third = expectation(description: "third write held")
        let model = model { request in
            if request.request.httpMethod == "POST" {
                switch writes.append(request) {
                case 1: first.fulfill()
                case 2: second.fulfill()
                case 3: third.fulfill()
                default: XCTFail("Unexpected replay")
                }
            } else {
                if refreshing.value { XCTAssertEqual(writes.count, 3, "Refresh must wait for every queued choice") }
                request.complete(withJSON: serverStatus.value)
            }
        }
        await model.load()
        let effort = model.setReasoningEffort("ultra")
        XCTAssertEqual(model.reasoningEffort, "ultra")
        await fulfillment(of: [first], timeout: 5)
        refreshing.value = true
        let refresh = Task { await model.load() }
        await drainMainActor()
        let thinking = model.setShowThinking(false)
        XCTAssertFalse(model.showThinking)
        let providerDefault = model.setReasoningEffort("")
        XCTAssertEqual(model.reasoningEffort, "")
        XCTAssertEqual(writes.count, 1)
        let body = try apiTestJSONBody(from: writes.request(at: 0).request)
        XCTAssertEqual(body["effort"] as? String, "ultra")
        XCTAssertNil(body["session_id"])
        writes.request(at: 0).complete(withJSON: Self.status(effort: "ultra"))
        await effort.value
        XCTAssertEqual(model.reasoningEffort, "")
        XCTAssertFalse(model.showThinking)
        await fulfillment(of: [second], timeout: 5)
        XCTAssertEqual(try apiTestJSONBody(from: writes.request(at: 1).request)["display"] as? String, "hide")
        writes.request(at: 1).complete(withJSON: Self.status(effort: "ultra", thinking: false))
        await thinking.value
        await fulfillment(of: [third], timeout: 5)
        XCTAssertEqual(try apiTestJSONBody(from: writes.request(at: 2).request)["effort"] as? String, "")
        serverStatus.value = Self.status(effort: "", thinking: false)
        writes.request(at: 2).complete(withJSON: serverStatus.value)
        await providerDefault.value
        await refresh.value
        XCTAssertEqual(model.reasoningEffort, "")
        XCTAssertFalse(model.showThinking)
        XCTAssertNil(model.errorMessage)
    }

    func testBothRefusedWritesRollBackAndPresentTheError() async {
        let model = model { request in
            if request.request.httpMethod == "POST" {
                request.complete(withJSON: #"{"error":"Profile is read only"}"#, statusCode: 403)
            } else { request.complete(withJSON: Self.status()) }
        }
        await model.load()
        await model.setReasoningEffort("ultra").value
        XCTAssertEqual(model.reasoningEffort, "medium")
        XCTAssertNotNil(model.errorMessage)
        await model.setShowThinking(false).value
        XCTAssertTrue(model.showThinking)
        XCTAssertNotNil(model.errorMessage)
    }

    func testUnknownWritesReconcileWithoutReplayingAndAFailedReadKeepsTheChoice() async {
        for field in ["effort", "display"] {
            for persisted in [false, true] {
                for readFails in [false, true] {
                    let written = LockedTestValue(false)
                    let online = LockedTestValue(true)
                    let writes = DeferredRequests()
                    let model = model { request in
                        if request.request.httpMethod == "POST" {
                            _ = writes.append(request)
                            written.value = true
                            online.value = !readFails
                            request.fail(with: URLError(.timedOut))
                        } else if !online.value {
                            request.fail(with: URLError(.notConnectedToInternet))
                        } else {
                            request.complete(withJSON: Self.status(
                                effort: written.value && persisted && field == "effort" ? "ultra" : "medium",
                                thinking: !(written.value && persisted && field == "display")))
                        }
                    }
                    await model.load()
                    await (field == "effort" ? model.setReasoningEffort("ultra") : model.setShowThinking(false)).value
                    XCTAssertEqual(model.reasoningEffort, (persisted || readFails) && field == "effort" ? "ultra" : "medium")
                    XCTAssertEqual(model.showThinking, !((persisted || readFails) && field == "display"))
                    XCTAssertNotNil(model.errorMessage)
                    online.value = true
                    await model.load()
                    XCTAssertEqual(model.reasoningEffort, persisted && field == "effort" ? "ultra" : "medium")
                    XCTAssertEqual(model.showThinking, !(persisted && field == "display"))
                    XCTAssertEqual(writes.count, 1, "Unknown writes must never be replayed")
                }
            }
        }
    }
}
