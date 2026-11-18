import XCTest
@testable import TalariaKit

final class SkillsViewModelTests: APIClientTestCase {
    @MainActor
    func testGroupedSkillsNormalizesBlankCategoriesAndSortsRows() {
        let groups = SkillsViewModel.groupedSkills(for: [
            SkillSummary(name: "zed", category: " coding ", description: nil, path: nil),
            SkillSummary(name: "Alpha", category: "coding", description: nil, path: nil),
            SkillSummary(name: "loose", category: "   ", description: nil, path: nil),
            SkillSummary(name: nil, category: nil, description: nil, path: nil)
        ])

        XCTAssertEqual(groups.map(\.category), ["coding", "Uncategorized"])
        XCTAssertEqual(groups.first?.skills.map(\.name), ["Alpha", "zed"])
        XCTAssertEqual(groups.last?.skills.map { $0.name ?? "Unnamed Skill" }, ["loose", "Unnamed Skill"])
    }

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
        let host = "skills-\(UUID().uuidString).test"
        let held = DeferredRequests()
        let toggleStarted = expectation(description: "toggle held")
        DeferredMockURLProtocol.setOnRequest({ request in
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
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let model = SkillsViewModel(client: APIClient(
            baseURL: try XCTUnwrap(URL(string: "https://\(host)")),
            session: URLSession(configuration: configuration)
        ))
        await model.load()

        let toggle = Task { await model.setSkill(try XCTUnwrap(model.skills.first), enabled: false) }
        await fulfillment(of: [toggleStarted], timeout: 10)
        XCTAssertEqual(model.skills.first?.disabled, true, "The switch shows the choice before the server answers")

        held.request(at: 0).fail(with: URLError(.notConnectedToInternet))
        try await toggle.value

        XCTAssertEqual(model.skills.first?.disabled, false)
        XCTAssertNotNil(model.lastError)
    }
}
