import XCTest
@testable import TalariaKit

/// Contract and view-model coverage for `GET /api/model/auxiliary` and the
/// auxiliary `POST /api/model/set` (TAL-388). Fixtures mirror the Web server
/// test in `web/packages/server/src/api/settings.test.ts`.
final class AuxiliaryModelsTests: APIClientTestCase {
    private static let taskIDs = [
        "vision", "web_extract", "compression", "approval", "mcp", "title_generation",
        "skills_hub", "curator", "kanban_decomposer", "profile_describer", "triage_specifier",
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
     "is_auto": false, "value_label": "legacy/gone-model", "provider_label": "OpenRouter", "selected_option_id": null, "in_catalog": false}
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
        XCTAssertEqual(model.tasks.count, 11)
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
