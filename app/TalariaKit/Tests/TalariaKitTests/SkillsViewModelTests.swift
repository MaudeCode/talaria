import XCTest
@testable import TalariaKit

final class SkillsViewModelTests: APIClientTestCase {
    @MainActor
    func testToggleSkillOptimisticallyUpdatesThenReloadsServerState() async throws {
        var paths: [String] = []
        var skillsLoadCount = 0
        let client = makeClient { request in
            paths.append(request.url?.path ?? "")
            switch request.url?.path {
            case "/api/skills":
                skillsLoadCount += 1
                let disabled = skillsLoadCount > 1
                return apiTestJSONResponse("""
                {"skills": [{"name": "swift-refactor", "category": "coding", "disabled": \(disabled)}]}
                """, for: request)
            case "/api/skills/toggle":
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual(body["name"] as? String, "swift-refactor")
                XCTAssertEqual(body["enabled"] as? Bool, false)
                return apiTestJSONResponse("""
                {"ok": true, "name": "swift-refactor", "enabled": false}
                """, for: request)
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let model = SkillsViewModel(client: client)

        await model.load()
        await model.setSkill(try XCTUnwrap(model.skills.first), enabled: false)

        XCTAssertEqual(paths, ["/api/skills", "/api/skills/toggle", "/api/skills"])
        XCTAssertEqual(model.skills.first?.disabled, true)
        XCTAssertNil(model.lastError)
    }

    @MainActor
    func testToggleSkillShowsTheChoiceAtOnceAndRollsBackOnFailure() async throws {
        let held = DeferredRequests()
        let toggleStarted = expectation(description: "toggle held")
        let model = try deferredModel { request in
            switch request.path {
            case "/api/skills":
                request.complete(withJSON: #"{"skills": [{"name": "swift-refactor", "category": "coding", "disabled": false}]}"#)
            case "/api/skills/toggle":
                _ = held.append(request)
                toggleStarted.fulfill()
            default:
                XCTFail("Unexpected path: \(request.path)")
                request.fail(with: URLError(.badURL))
            }
        }
        await model.load()

        let toggle = Task { await model.setSkill(try XCTUnwrap(model.skills.first), enabled: false) }
        await fulfillment(of: [toggleStarted], timeout: 10)
        XCTAssertEqual(model.skills.first?.disabled, true, "The switch shows the choice before the server answers")

        held.request(at: 0).fail(with: URLError(.notConnectedToInternet))
        try await toggle.value

        XCTAssertEqual(model.skills.first?.disabled, false)
        XCTAssertNotNil(model.lastError)
    }

    // TAL-2528: the server chooses the matching rows; the App sends the text and renders the answer.
    @MainActor
    func testSearchSendsTheTextAndRendersTheServerAnswer() async throws {
        var queries: [String?] = []
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/skills")
            let query = Self.query(of: request.url)
            queries.append(query)
            let name = query.map { "match-\($0)" } ?? "everything"
            return apiTestJSONResponse(#"{"skills": [{"name": "\#(name)", "category": "coding"}]}"#, for: request)
        }
        let model = SkillsViewModel(client: client)

        await model.search("  PDF ")
        XCTAssertEqual(model.groupedSkills.flatMap { $0.skills.compactMap(\.name) }, ["match-PDF"])

        await model.search("")
        XCTAssertEqual(queries, ["PDF", nil])
        XCTAssertEqual(model.skills.compactMap(\.name), ["everything"])
    }

    @MainActor
    func testNewerSearchWinsAndRowsStayWhileASearchLoads() async throws {
        let held = DeferredRequestsByPath()
        let olderHeld = expectation(description: "older search held")
        let newerHeld = expectation(description: "newer search held")
        let model = try deferredModel { request in
            switch Self.query(of: request.request.url) {
            case nil:
                request.complete(withJSON: #"{"skills": [{"name": "shown"}]}"#)
            case let query?:
                held.record(request, as: query)
                (query == "a" ? olderHeld : newerHeld).fulfill()
            }
        }
        await model.load()

        let older = Task { await model.search("a") }
        await fulfillment(of: [olderHeld], timeout: 10)
        let newer = Task { await model.search("ab") }
        await fulfillment(of: [newerHeld], timeout: 10)
        XCTAssertEqual(model.skills.compactMap(\.name), ["shown"], "The last rows stay while a search loads")

        try XCTUnwrap(held.request("ab")).complete(withJSON: #"{"skills": [{"name": "newer"}]}"#)
        await newer.value
        try XCTUnwrap(held.request("a")).complete(withJSON: #"{"skills": [{"name": "older"}]}"#)
        await older.value

        XCTAssertEqual(model.skills.compactMap(\.name), ["newer"])
    }

    private static func query(of url: URL?) -> String? {
        url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value }
    }

    @MainActor
    private func deferredModel(_ onRequest: @escaping (DeferredMockURLProtocol) -> Void) throws -> SkillsViewModel {
        let host = "skills-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(onRequest, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        return SkillsViewModel(client: APIClient(
            baseURL: try XCTUnwrap(URL(string: "https://\(host)")),
            session: URLSession(configuration: configuration)
        ))
    }
}
