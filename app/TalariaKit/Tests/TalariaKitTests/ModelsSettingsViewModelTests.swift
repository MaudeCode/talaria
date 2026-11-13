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

    private func client(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> APIClient {
        let host = "models-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config))
        return client
    }

    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> ModelsSettingsViewModel {
        ModelsSettingsViewModel(client: client(handler))
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
    private func picker(favorites: [ModelFavoriteKey] = [], _ handler: @escaping (DeferredMockURLProtocol) -> Void) -> SettingsModelPickerViewModel {
        let name = "SettingsModelPickerTests.\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
        let store = ModelFavoritesStore(defaults: defaults, storageKey: "stars")
        store.save(favorites)
        return SettingsModelPickerViewModel(client: client(handler), favorites: store, live: true)
    }

    private func pickerJSON(star: Bool = true, hidden: Bool = false, empty: Bool = false, neverSaved: Bool = false) throws -> String {
        var value = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("settings-model-picker")) as? [String: Any])
        if neverSaved { value["favorites"] = NSNull() }
        var groups = try XCTUnwrap(value["groups"] as? [[String: Any]])
        var rows = try XCTUnwrap(groups[0]["models"] as? [[String: Any]])
        value["favorite_models"] = star ? [rows[0]] : []
        rows[0]["favorite"] = star
        rows[0]["hidden"] = hidden
        groups[0]["models"] = rows
        value["groups"] = empty ? [] : groups
        return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    func testSettingsPickerImportsLegacyStarsOnlyForAnUninitializedServerProfileAndUsesServerFields() async throws {
        let wire = LockedTestValue(try pickerJSON(neverSaved: true))
        let initialized = try pickerJSON()
        let imports = LockedTestValue(0)
        let liveQueries = LockedTestValue([String]())
        let picker = picker(favorites: [ModelFavoriteKey(modelID: "@alpha:shared", providerID: "alpha")]) { request in
            if request.request.httpMethod == "POST" {
                imports.value += 1
                XCTAssertEqual(request.request.url?.path, "/api/models/favorites/import")
                let body = try? apiTestJSONBody(from: request.request)
                XCTAssertEqual(body?["profile"] as? String, "work")
                XCTAssertEqual(body?["favorites"] as? [[String: String]], [["provider_id": "alpha", "model": "@alpha:shared"]])
                wire.value = initialized
                request.complete(withJSON: #"{"ok":true}"#)
            } else {
                XCTAssertEqual(request.request.url?.path, "/api/models/picker")
                let query = URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems
                liveQueries.value.append(query?.first { $0.name == "live" }?.value ?? "")
                request.complete(withJSON: wire.value)
            }
        }
        await picker.load()
        await picker.load()
        XCTAssertEqual(imports.value, 1)
        XCTAssertEqual(liveQueries.value.first, "false")
        XCTAssertEqual(liveQueries.value.last, "true")
        XCTAssertEqual(picker.providers.map(\.label), ["Alpha Models", "Beta Models"])
        XCTAssertEqual(picker.groups.first?.name, "Alpha Models")
        XCTAssertEqual(picker.groups.first?.modelCount, 1)
        let option = try XCTUnwrap(picker.groups.first?.models.first)
        XCTAssertTrue(option.isFavorite)
        XCTAssertFalse(option.isHidden)
        XCTAssertTrue(option.preferencesEditable)
        XCTAssertEqual(option.bareID, "shared")
        XCTAssertEqual(picker.favoriteOptions, [option])
    }

    func testSettingsPickerPreferencesAppearImmediatelyAndRollBackDefinitiveRefusals() async throws {
        for hiding in [false, true] {
            let writes = DeferredRequests()
            let held = expectation(description: "preference write held")
            let wire = try pickerJSON()
            let picker = picker { request in
                if request.request.httpMethod == "POST" { writes.append(request); held.fulfill() }
                else { request.complete(withJSON: wire) }
            }
            picker.favoritesOnly = !hiding
            await picker.load()
            let option = try XCTUnwrap(picker.groups.first?.models.first)
            let task = Task { if hiding { await picker.toggleHidden(option) } else { await picker.toggleFavorite(option) } }
            await fulfillment(of: [held], timeout: 5)
            XCTAssertTrue(picker.groups.isEmpty, "The tapped row must disappear before the held write answers")
            let body = try apiTestJSONBody(from: writes.request(at: 0).request)
            XCTAssertEqual(body["provider_id"] as? String, "alpha")
            XCTAssertEqual(body["model"] as? String, "shared")
            XCTAssertEqual(body["profile"] as? String, "work")
            XCTAssertEqual(writes.request(at: 0).request.url?.path, hiding ? "/api/models/hidden" : "/api/models/favorite")
            writes.request(at: 0).complete(withJSON: #"{"error":"Refused"}"#, statusCode: 400)
            await task.value
            XCTAssertEqual(picker.groups.first?.models.first?.isFavorite, true)
            XCTAssertEqual(picker.groups.first?.models.first?.isHidden, false)
            XCTAssertNotNil(picker.preferenceError)
            XCTAssertEqual(writes.count, 1)
        }
    }

    func testSettingsPickerUnknownWritesReconcileWithoutReplayIncludingAnInitiallyFailedRead() async throws {
        let cases = [false, true].flatMap { hiding in ["network", "server-error", "missing-ack"].map { (hiding, $0) } }
        for (hiding, outcome) in cases {
            for persisted in [false, true] {
                for readFails in [false, true] {
                    let before = try pickerJSON()
                    let after = try pickerJSON(empty: persisted)
                    let written = LockedTestValue(false)
                    let online = LockedTestValue(true)
                    let writes = LockedTestValue(0)
                    let picker = picker { request in
                        if request.request.httpMethod == "POST" {
                            writes.value += 1
                            written.value = true
                            online.value = !readFails
                            switch outcome {
                            case "server-error": request.complete(withJSON: #"{"error":"Unavailable"}"#, statusCode: 503)
                            case "missing-ack": request.complete(withJSON: "{}")
                            default: request.fail(with: URLError(.networkConnectionLost))
                            }
                        } else if !online.value {
                            request.fail(with: URLError(.notConnectedToInternet))
                        } else {
                            request.complete(withJSON: written.value ? after : before)
                        }
                    }
                    picker.favoritesOnly = !hiding
                    await picker.load()
                    let option = try XCTUnwrap(picker.groups.first?.models.first)
                    if hiding { await picker.toggleHidden(option) } else { await picker.toggleFavorite(option) }
                    XCTAssertEqual(picker.groups.isEmpty, persisted || readFails)
                    XCTAssertNotNil(picker.preferenceError)
                    online.value = true
                    await picker.load()
                    XCTAssertEqual(picker.groups.isEmpty, persisted)
                    XCTAssertEqual(writes.value, 1, "An unknown preference write is never replayed")
                }
            }
        }
    }

    func testSettingsPickerAcknowledgementsCannotEraseTheOtherQueuedPreference() async throws {
        let writes = DeferredRequests()
        let first = expectation(description: "star held")
        let second = expectation(description: "second star held")
        let third = expectation(description: "hide held")
        let wire = LockedTestValue(try pickerJSON())
        let picker = picker { request in
            if request.request.httpMethod == "POST" {
                switch writes.append(request) {
                case 1: first.fulfill()
                case 2: second.fulfill()
                default: third.fulfill()
                }
            } else { request.complete(withJSON: wire.value) }
        }
        await picker.load()
        let option = try XCTUnwrap(picker.groups.first?.models.first)
        let star = Task { await picker.toggleFavorite(option) }
        await fulfillment(of: [first], timeout: 5)
        let starAgain = Task { await picker.toggleFavorite(option) }
        await drainMainActor()
        XCTAssertEqual(picker.groups.first?.models.first?.isFavorite, true, "Two taps on the same rendered row must toggle the newest optimistic value")
        let hide = Task { await picker.toggleHidden(option) }
        await drainMainActor()
        XCTAssertTrue(picker.groups.isEmpty)
        wire.value = try pickerJSON(star: false)
        writes.request(at: 0).complete(withJSON: #"{"ok":true}"#)
        await star.value
        await fulfillment(of: [second], timeout: 5)
        XCTAssertEqual(try apiTestJSONBody(from: writes.request(at: 1).request)["favorite"] as? Bool, true)
        wire.value = try pickerJSON(star: true)
        writes.request(at: 1).complete(withJSON: #"{"ok":true}"#)
        await starAgain.value
        await fulfillment(of: [third], timeout: 5)
        XCTAssertTrue(picker.groups.isEmpty, "Both star readbacks must retain the later hide intent")
        wire.value = try pickerJSON(empty: true)
        writes.request(at: 2).complete(withJSON: #"{"ok":true}"#)
        await hide.value
        XCTAssertTrue(picker.groups.isEmpty)
        XCTAssertEqual(writes.count, 3)
    }

    func testSettingsPickerRetainsItsProfileWhenAnotherWindowSwitchesProfiles() async throws {
        let wire = LockedTestValue(try pickerJSON())
        let sentProfile = LockedTestValue<String?>(nil)
        let picker = picker { request in
            if request.request.httpMethod == "POST" {
                sentProfile.value = (try? apiTestJSONBody(from: request.request))?["profile"] as? String
                request.complete(withJSON: #"{"error":"The active profile changed"}"#, statusCode: 409)
            } else { request.complete(withJSON: wire.value) }
        }
        await picker.load()
        let originalOption = try XCTUnwrap(picker.groups.first?.models.first)
        var changed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(wire.value.utf8)) as? [String: Any])
        changed["profile"] = "other"
        wire.value = String(decoding: try JSONSerialization.data(withJSONObject: changed), as: UTF8.self)
        await picker.load()
        await picker.toggleFavorite(originalOption)
        XCTAssertEqual(picker.response?.profile, "work", "A mounted picker must not adopt another profile's catalog")
        XCTAssertEqual(sentProfile.value, "work", "An old row action must remain bound to the profile that supplied it")
        XCTAssertNotNil(picker.preferenceError)
    }

}
