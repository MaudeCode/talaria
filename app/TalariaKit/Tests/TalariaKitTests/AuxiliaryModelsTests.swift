import XCTest
@testable import TalariaKit

/// Contract and view-model coverage for `GET /api/model/auxiliary` and the
/// auxiliary `POST /api/model/set` (TAL-388). Fixtures mirror the Web server
/// test in `web/packages/server/src/api/settings.test.ts`.
final class AuxiliaryModelsTests: APIClientTestCase {
    private static let taskIDs = [
        "vision", "web_extract", "compression", "approval", "mcp", "title_generation",
        "skills_hub", "curator", "kanban_decomposer", "profile_describer", "triage_specifier", "delegation",
    ]

    private static func taskJSON(_ id: String, override: String? = nil) -> String {
        override ?? """
        {"task": "\(id)", "label": "\(id)", "description": "\(id) description", "provider": "auto", "model": "",
         "is_auto": true, "value_label": "Claude Sonnet 4.6", "provider_label": "Anthropic",
         "selected_option_id": null, "in_catalog": true, "base_url": "", "api_key_set": false}
        """
    }

    private static func auxiliaryJSON(_ overrides: [String: String] = [:]) -> String {
        let tasks = taskIDs.map { taskJSON($0, override: overrides[$0]) }.joined(separator: ",")
        return #"{"main": {"provider": "anthropic", "model": "claude-sonnet-4-6"}, "tasks": [\#(tasks)]}"#
    }

    private static let pinnedBeta = """
    {"task": "title_generation", "label": "Title generation", "description": "session titles", "provider": "custom:beta", "model": "llama3",
     "is_auto": false, "value_label": "Llama3", "provider_label": "beta", "selected_option_id": "@custom:beta:llama3", "in_catalog": true}
    """

    private static let offCatalogVision = """
    {"task": "vision", "label": "Vision", "description": "image/screenshot analysis", "provider": "openrouter", "model": "legacy/gone-model",
     "is_auto": false, "value_label": "legacy/gone-model", "provider_label": "OpenRouter", "selected_option_id": null, "in_catalog": false,
     "reasoning":{"saved":null,"effective":"low","inherited":true,"default_source":"provider","options":["low","high"],"unavailable":null}}
    """

    func testDecodesEveryServerSlotInOrderWithAutoPinnedAndOffCatalogValues() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/model/auxiliary")
            return apiTestJSONResponse(Self.auxiliaryJSON(["vision": Self.offCatalogVision, "title_generation": Self.pinnedBeta]), for: request)
        }

        let response = try await client.auxiliaryModels()

        XCTAssertTrue(response.isSupported)
        XCTAssertEqual(response.tasks.map(\.task), Self.taskIDs)
        let vision = try XCTUnwrap(response.tasks.first)
        XCTAssertEqual(vision.isAuto, false)
        XCTAssertEqual(vision.inCatalog, false)
        XCTAssertEqual(vision.valueLabel, "legacy/gone-model")
        XCTAssertEqual(vision.providerLabel, "OpenRouter")
        XCTAssertNil(vision.selectedOptionID)
        let title = try XCTUnwrap(response.tasks.first { $0.task == "title_generation" })
        XCTAssertEqual(title.label, "Title generation")
        XCTAssertEqual(title.selectedOptionID, "@custom:beta:llama3")
        XCTAssertEqual(title.provider, "custom:beta")
        XCTAssertEqual(title.model, "llama3")
        let compression = try XCTUnwrap(response.tasks.first { $0.task == "compression" })
        XCTAssertEqual(compression.isAuto, true)
        XCTAssertEqual(compression.valueLabel, "Claude Sonnet 4.6")
    }

    func testAServerWithoutTypedSlotFieldsIsUnsupported() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let legacy = try decoder.decode(AuxiliaryModelsResponse.self, from: Data("""
        {"main": {}, "tasks": [{"task": "vision", "label": "Vision", "provider": "auto", "model": ""}, {"label": "no id"}]}
        """.utf8))

        XCTAssertEqual(legacy.tasks.map(\.task), ["vision"])
        XCTAssertFalse(legacy.isSupported)
    }

    func testSaveSendsTheCatalogEntryAndItsProvider() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/model/set")
            let body = try XCTUnwrap(apiTestBodyData(from: request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(json, ["scope": "auxiliary", "task": "title_generation", "model": "@custom:beta:llama3", "provider": "custom:beta"])
            return apiTestJSONResponse(#"{"ok": true, "auxiliary": \#(Self.auxiliaryJSON(["title_generation": Self.pinnedBeta]))}"#, for: request)
        }

        let response = try await client.setAuxiliaryModel(task: "title_generation", model: "@custom:beta:llama3", provider: "custom:beta")

        XCTAssertEqual(response.ok, true)
        XCTAssertEqual(response.auxiliary?.tasks.first { $0.task == "title_generation" }?.selectedOptionID, "@custom:beta:llama3")
    }

    @MainActor
    private func deferredModel(server: URL) -> AuxiliaryModelsViewModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        return AuxiliaryModelsViewModel(server: server,
            client: APIClient(baseURL: server, session: URLSession(configuration: configuration)))
    }

    @MainActor
    func testFreshTaskCacheReusesBothEmptyAndPopulatedResponses() async throws {
        for body in [#"{"tasks":[]}"#, Self.auxiliaryJSON()] {
            let reads = LockedTestValue(0)
            let client = makeClient { request in
                reads.value += 1
                return apiTestJSONResponse(body, for: request)
            }
            let model = AuxiliaryModelsViewModel(server: client.baseURL, client: client)
            await model.loadIfNeeded()
            await model.loadIfNeeded()
            XCTAssertEqual(reads.value, 1)
            XCTAssertFalse(model.isUnavailable, "A valid empty task list is distinct from an older server")
            XCTAssertFalse(model.isLoading)
            await model.load()
            XCTAssertEqual(reads.value, 2, "Explicit refresh bypasses freshness")
        }
    }

    @MainActor
    func testConcurrentTaskLoadsShareOneRequestAndKeepCachedValuesOnRefreshFailure() async throws {
        let requests = DeferredRequests()
        let started = expectation(description: "one auxiliary read")
        started.assertForOverFulfill = false
        DeferredMockURLProtocol.onRequest = { request in
            let count = requests.append(request)
            started.fulfill()
            if count > 1 { request.complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision])) }
        }
        defer { DeferredMockURLProtocol.onRequest = nil }
        let model = deferredModel(server: URL(string: "https://aux-cache.test")!)
        let first = Task { await model.load() }
        await fulfillment(of: [started])
        let second = Task { await model.load() }
        await drainMainActor()
        requests.request(at: 0).complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision]))
        await first.value
        await second.value
        XCTAssertEqual(requests.count, 1, "Concurrent task navigation must coalesce discovery")
        XCTAssertEqual(model.task(id: "vision")?.model, "legacy/gone-model")
        let refreshIndex = requests.count
        let refreshing = expectation(description: "refresh read")
        DeferredMockURLProtocol.onRequest = { request in
            _ = requests.append(request)
            refreshing.fulfill()
        }
        let refresh = Task { await model.load() }
        await fulfillment(of: [refreshing])
        XCTAssertEqual(model.task(id: "vision")?.model, "legacy/gone-model")
        requests.request(at: refreshIndex).fail(with: URLError(.cannotConnectToHost))
        await refresh.value
        XCTAssertEqual(model.task(id: "vision")?.model, "legacy/gone-model")
        XCTAssertNotNil(model.errorMessage)
    }

    func testReasoningContractAndEffortOnlyWritesDistinguishClearFromOmission() async throws {
        let client = makeClient { request in
            if request.httpMethod == "POST" {
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(apiTestBodyData(from: request))) as? [String: Any])
                XCTAssertNil(body["model"], "An effort-only edit must preserve a custom route")
                XCTAssertNil(body["provider"])
                XCTAssertTrue(body["reasoning_effort"] is NSNull, "Clearing effort sends JSON null, not omission")
                return apiTestJSONResponse(#"{"ok":true}"#, for: request)
            }
            return apiTestJSONResponse(#"{"tasks":[{"task":"plugin_task","provider":"custom:beta","model":"llama3","is_auto":false,"in_catalog":false,"reasoning":{"saved":"high","effective":"high","inherited":false,"default_source":"parent","options":["low","high","future-level"],"unavailable":null}}]}"#, for: request)
        }
        let response = try await client.auxiliaryModels()
        XCTAssertEqual(response.tasks.first?.reasoning?.saved, "high")
        XCTAssertEqual(response.tasks.first?.reasoning?.options, ["low", "high", "future-level"])
        XCTAssertEqual(response.tasks.first?.reasoning?.defaultSource, "parent")
        _ = try await client.setAuxiliaryModel(task: "plugin_task", reasoningEffort: nil, writesReasoning: true)
    }

    @MainActor
    func testDraftCancelRefusalAndUnknownSaveRetainConfirmedStateWithoutReplaying() async throws {
        let posts = LockedTestValue(0)
        let reads = LockedTestValue(0)
        let client = makeClient { request in
            if request.httpMethod == "POST" {
                posts.value += 1
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(apiTestBodyData(from: request))) as? [String: Any])
                XCTAssertEqual(body["reasoning_effort"] as? String, "high")
                XCTAssertNil(body["model"])
                XCTAssertNil(body["provider"])
                if posts.value == 1 { return apiTestJSONResponse(#"{"error":"fixture refusal"}"#, statusCode: 400, for: request) }
                throw URLError(.networkConnectionLost)
            }
            reads.value += 1
            let saved = posts.value >= 2 ? #""high""# : "null"
            let inherited = posts.value < 2
            return apiTestJSONResponse(#"{"tasks":[{"task":"plugin_task","label":"Plugin Task","provider":"custom:beta","model":"llama3","is_auto":false,"in_catalog":false,"reasoning":{"saved":\#(saved),"effective":"low","inherited":\#(inherited),"default_source":"provider","options":["low","high"],"unavailable":null}}]}"#, for: request)
        }
        let model = AuxiliaryModelsViewModel(server: client.baseURL, client: client)
        await model.load()
        model.beginEditing(task: "plugin_task")
        model.selectEffort("high")
        model.cancelEditing()
        XCTAssertNil(model.draft)
        XCTAssertEqual(posts.value, 0)
        model.beginEditing(task: "plugin_task")
        model.selectEffort("unsupported")
        XCTAssertFalse(try XCTUnwrap(model.draft).hasChanges)
        model.selectEffort("high")
        let refused = await model.saveDraft()
        XCTAssertFalse(refused)
        XCTAssertEqual(model.draft?.effort, "high")
        XCTAssertNil(model.task(id: "plugin_task")?.reasoning?.saved)
        XCTAssertNotNil(model.saveErrorMessage)
        let unknown = await model.saveDraft()
        XCTAssertFalse(unknown)
        XCTAssertEqual(posts.value, 2)
        XCTAssertEqual(reads.value, 2, "An unknown outcome reads authoritative values once")
        XCTAssertEqual(model.draft?.effort, "high")
        XCTAssertEqual(model.task(id: "plugin_task")?.reasoning?.saved, "high")
        XCTAssertEqual(model.draft?.original.reasoning?.saved, "high", "The retained editor must show the reconciled confirmed value")
    }

    @MainActor
    func testAtomicDraftSavesTheExactProviderAndEffortAndAdoptsServerValues() async throws {
        let pinned = Self.offCatalogVision.replacingOccurrences(of: "legacy/gone-model", with: "same-id")
            .replacingOccurrences(of: "openrouter", with: "beta")
            .replacingOccurrences(of: #""saved":null"#, with: #""saved":"high""#)
            .replacingOccurrences(of: #""effective":"low""#, with: #""effective":"high""#)
            .replacingOccurrences(of: #""inherited":true"#, with: #""inherited":false"#)
        let writes = LockedTestValue(0)
        let client = makeClient { request in
            if request.url?.path == "/api/reasoning" {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(query?.first { $0.name == "provider" }?.value, "beta")
                return apiTestJSONResponse(#"{"supports_reasoning_effort":true,"supported_efforts":["high"]}"#, for: request)
            }
            if request.httpMethod == "POST" {
                writes.value += 1
                XCTAssertEqual(request.url?.path, "/api/model/set")
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(apiTestBodyData(from: request))) as? [String: String])
                XCTAssertEqual(body, ["scope":"auxiliary","task":"vision","model":"same-id","provider":"beta","reasoning_effort":"high"])
                return apiTestJSONResponse(#"{"ok":true,"auxiliary":\#(Self.auxiliaryJSON(["vision":pinned]))}"#, for: request)
            }
            return apiTestJSONResponse(Self.auxiliaryJSON(["vision": Self.offCatalogVision]), for: request)
        }
        let model = AuxiliaryModelsViewModel(server: client.baseURL, client: client)
        await model.load()
        model.beginEditing(task: "vision")
        await model.selectModel("same-id", provider: "beta")
        model.selectEffort("high")
        let saved = await model.saveDraft()
        XCTAssertTrue(saved)
        XCTAssertNil(model.draft)
        XCTAssertEqual(writes.value, 1)
        XCTAssertEqual(model.task(id: "vision")?.provider, "beta")
        XCTAssertEqual(model.task(id: "vision")?.reasoning?.saved, "high")
        XCTAssertEqual(model.task(id: "vision")?.reasoning?.effective, "high")
        XCTAssertEqual(model.task(id: "compression")?.isAuto, true)
    }

    @MainActor
    func testLateModelCapabilitiesCannotReplaceANewerChoice() async throws {
        let server = URL(string: "https://aux-capability.test")!
        let pending = DeferredRequests()
        let firstRead = expectation(description: "first provider capability")
        let secondRead = expectation(description: "second provider capability")
        DeferredMockURLProtocol.setOnRequest({ request in
            if request.request.url?.path == "/api/model/auxiliary" {
                request.complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision]))
            } else {
                let count = pending.append(request)
                (count == 1 ? firstRead : secondRead).fulfill()
            }
        }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let model = deferredModel(server: server)
        await model.load()
        model.beginEditing(task: "vision")
        let first = Task { await model.selectModel("same-id", provider: "alpha") }
        await fulfillment(of: [firstRead])
        let second = Task { await model.selectModel("same-id", provider: "beta") }
        await fulfillment(of: [secondRead])
        pending.request(at: 1).complete(withJSON: #"{"supports_reasoning_effort":true,"supported_efforts":["high"]}"#)
        await second.value
        XCTAssertEqual(model.draft?.provider, "beta")
        XCTAssertEqual(model.draft?.options, ["high"])
        pending.request(at: 0).complete(withJSON: #"{"supports_reasoning_effort":true,"supported_efforts":["low"]}"#)
        await first.value
        XCTAssertEqual(model.draft?.options, ["high"], "A late answer for an identically named model on another provider is stale")
        XCTAssertEqual(model.task(id: "vision")?.model, "legacy/gone-model", "Choosing in the picker only changes the draft")
        model.cancelEditing()
        XCTAssertNil(model.draft)
    }

    @MainActor
    func testAcknowledgedSaveKeepsEditsMadeWhileTheRequestWasPending() async throws {
        let server = URL(string: "https://aux-save-draft.test")!
        let pending = DeferredRequests()
        let posted = expectation(description: "draft save")
        DeferredMockURLProtocol.setOnRequest({ request in
            if request.request.httpMethod == "POST" { _ = pending.append(request); posted.fulfill() }
            else { request.complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision])) }
        }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let model = deferredModel(server: server)
        await model.load()
        model.beginEditing(task: "vision")
        model.selectEffort("high")
        let saving = Task { await model.saveDraft() }
        await fulfillment(of: [posted])
        model.selectEffort("low")
        let confirmed = Self.offCatalogVision.replacingOccurrences(of: #""saved":null"#, with: #""saved":"high""#)
            .replacingOccurrences(of: #""effective":"low""#, with: #""effective":"high""#)
            .replacingOccurrences(of: #""inherited":true"#, with: #""inherited":false"#)
        pending.request(at: 0).complete(withJSON: #"{"ok":true,"auxiliary":\#(Self.auxiliaryJSON(["vision":confirmed]))}"#)
        let shouldClose = await saving.value
        XCTAssertFalse(shouldClose, "An older save must not dismiss a newer local edit")
        XCTAssertEqual(model.draft?.effort, "low")
        XCTAssertEqual(model.draft?.original.reasoning?.saved, "high")
    }

    @MainActor
    func testCanceledEditorDoesNotReceiveALateSaveErrorInTheNextTask() async throws {
        let server = URL(string: "https://aux-late-error.test")!
        let pending = DeferredRequests()
        let posted = expectation(description: "old task write")
        DeferredMockURLProtocol.setOnRequest({ request in
            if request.request.httpMethod == "POST" { _ = pending.append(request); posted.fulfill() }
            else { request.complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision])) }
        }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let model = deferredModel(server: server)
        await model.load()
        model.beginEditing(task: "vision")
        model.selectEffort("high")
        let saving = Task { await model.saveDraft() }
        await fulfillment(of: [posted])
        model.cancelEditing()
        model.beginEditing(task: "compression")
        pending.request(at: 0).complete(withJSON: #"{"error":"old vision refusal"}"#, statusCode: 400)
        _ = await saving.value
        XCTAssertEqual(model.draft?.original.task, "compression")
        XCTAssertNil(model.saveErrorMessage, "A dismissed editor's late error must not appear in another task")
    }

    @MainActor
    func testLateRefreshCannotOverwriteAnAcknowledgedSave() async throws {
        let server = URL(string: "https://aux-save-refresh.test")!
        let reads = LockedTestValue(0)
        let pending = DeferredRequests()
        let posted = expectation(description: "task save")
        let refreshing = expectation(description: "concurrent refresh")
        DeferredMockURLProtocol.setOnRequest({ request in
            if request.request.httpMethod == "POST" { _ = pending.append(request); posted.fulfill() }
            else {
                reads.value += 1
                if reads.value == 1 { request.complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision])) }
                else { _ = pending.append(request); refreshing.fulfill() }
            }
        }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let model = deferredModel(server: server)
        await model.load()
        let saving = Task { await model.save(task: "vision", model: "new-vision", provider: "openrouter") }
        await fulfillment(of: [posted])
        let refresh = Task { await model.load() }
        await fulfillment(of: [refreshing])
        let updated = Self.offCatalogVision.replacingOccurrences(of: "legacy/gone-model", with: "new-vision")
        pending.request(at: 0).complete(withJSON: #"{"ok":true,"auxiliary":\#(Self.auxiliaryJSON(["vision":updated]))}"#)
        let saved = await saving.value
        XCTAssertTrue(saved)
        pending.request(at: 1).complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision]))
        await refresh.value
        XCTAssertEqual(model.task(id: "vision")?.model, "new-vision", "A read begun before acknowledgement cannot restore the previous model")
    }

    @MainActor
    func testProfileSwitchRejectsALateSaveResponse() async throws {
        let server = URL(string: "https://aux-save-profile.test")!
        defer { ActiveServerProfile.record(nil, for: server) }
        let pending = DeferredRequests()
        let posted = expectation(description: "old profile write")
        DeferredMockURLProtocol.setOnRequest({ request in
            if request.request.httpMethod == "POST" { _ = pending.append(request); posted.fulfill() }
            else { request.complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision])) }
        }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let model = deferredModel(server: server)
        await model.load()
        let saving = Task { await model.save(task: "vision", model: "same-id", provider: "beta") }
        await fulfillment(of: [posted])
        XCTAssertEqual(model.task(id: "vision")?.model, "same-id", "The user's save is visible immediately")
        ActiveServerProfile.record("other", for: server)
        pending.request(at: 0).complete(withJSON: #"{"ok":true,"auxiliary":\#(Self.auxiliaryJSON())}"#)
        let saved = await saving.value
        XCTAssertFalse(saved)
        XCTAssertTrue(model.tasks.isEmpty)
        XCTAssertNil(model.savingTaskID)
    }

    @MainActor
    func testProfileSwitchRejectsLateLoadAndReplacesTheScopedCatalog() async throws {
        let server = URL(string: "https://aux-profile.test")!
        defer { ActiveServerProfile.record(nil, for: server) }
        let pending = DeferredRequests()
        let read = expectation(description: "old profile read")
        DeferredMockURLProtocol.setOnRequest({ request in _ = pending.append(request); read.fulfill() }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let model = deferredModel(server: server)
        let catalog = model.catalog
        let load = Task { await model.load() }
        await fulfillment(of: [read])
        ActiveServerProfile.record("other", for: server)
        pending.request(at: 0).complete(withJSON: Self.auxiliaryJSON(["vision": Self.offCatalogVision]))
        await load.value
        XCTAssertTrue(model.tasks.isEmpty, "Old-profile answers must never populate the new profile")
        XCTAssertFalse(model.catalog === catalog)
        XCTAssertNil(model.draft)
        XCTAssertFalse(model.isLoading)
    }

    @MainActor
    func testViewModelReplacesEverySlotWhenTheProfileChanges() async throws {
        var load = 0
        let client = makeClient { request in
            load += 1
            // The second read answers another profile: nothing from the first may survive.
            let body = load == 1 ? Self.auxiliaryJSON(["title_generation": Self.pinnedBeta]) : Self.auxiliaryJSON(["vision": Self.offCatalogVision])
            return apiTestJSONResponse(body, for: request)
        }
        let model = AuxiliaryModelsViewModel(server: URL(string: "https://example.test")!, client: client)

        await model.load()
        XCTAssertEqual(model.task(id: "title_generation")?.selectedOptionID, "@custom:beta:llama3")

        await model.load()
        XCTAssertEqual(model.task(id: "title_generation")?.isAuto, true)
        XCTAssertNil(model.task(id: "title_generation")?.selectedOptionID)
        XCTAssertEqual(model.task(id: "vision")?.inCatalog, false)
        XCTAssertEqual(model.tasks.count, Self.taskIDs.count)
        XCTAssertFalse(model.isUnavailable)
    }

    @MainActor
    func testViewModelKeepsThePriorValueWhenAWriteFails() async throws {
        let client = makeClient { request in
            if request.httpMethod == "POST" {
                return apiTestJSONResponse(#"{"error": "provider-qualified auxiliary model must match the selected provider"}"#, statusCode: 400, for: request)
            }
            return apiTestJSONResponse(Self.auxiliaryJSON(["title_generation": Self.pinnedBeta]), for: request)
        }
        let model = AuxiliaryModelsViewModel(server: URL(string: "https://example.test")!, client: client)
        await model.load()

        let saved = await model.save(task: "title_generation", model: "@openai:", provider: nil)

        XCTAssertFalse(saved)
        XCTAssertEqual(model.task(id: "title_generation")?.selectedOptionID, "@custom:beta:llama3")
        XCTAssertTrue(model.saveErrorMessage?.contains("must match the selected provider") == true)
        XCTAssertNil(model.savingTaskID)
    }

    @MainActor
    func testViewModelAppliesTheServerStateAfterResetAll() async throws {
        var posted: [String: String]?
        let client = makeClient { request in
            if request.httpMethod == "POST" {
                posted = try JSONSerialization.jsonObject(with: XCTUnwrap(apiTestBodyData(from: request))) as? [String: String]
                return apiTestJSONResponse(#"{"ok": true, "auxiliary": \#(Self.auxiliaryJSON())}"#, for: request)
            }
            return apiTestJSONResponse(Self.auxiliaryJSON(["vision": Self.offCatalogVision]), for: request)
        }
        let model = AuxiliaryModelsViewModel(server: URL(string: "https://example.test")!, client: client)
        await model.load()

        let reset = await model.resetAll()

        XCTAssertTrue(reset)
        XCTAssertEqual(posted, ["scope": "auxiliary", "task": "__reset__", "model": "", "provider": "auto"])
        XCTAssertTrue(model.tasks.allSatisfy { $0.isAuto == true })
    }

    @MainActor
    func testViewModelShowsUnavailableWhenTheServerLacksTheRoute() async {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"error": "not found"}"#, statusCode: 404, for: request)
        }
        let model = AuxiliaryModelsViewModel(server: URL(string: "https://example.test")!, client: client)

        await model.load()

        XCTAssertTrue(model.isUnavailable)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.tasks.isEmpty)
    }
}
