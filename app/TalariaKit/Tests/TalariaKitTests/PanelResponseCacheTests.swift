import XCTest
@testable import TalariaKit

// TAL-437: Tasks, Skills and Memory show their last content on the next visit or launch, then
// update from the server.
@MainActor
final class PanelResponseCacheTests: XCTestCase {
    private let server = URL(string: "https://example.test")!

    private func makeCache() -> ResponseCache {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return ResponseCache(server: server, root: root)
    }

    private func makeClient(_ handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(handler)]
        return APIClient(baseURL: server, session: URLSession(configuration: configuration))
    }

    private func offlineClient() -> APIClient {
        makeClient { _ in throw URLError(.notConnectedToInternet) }
    }

    func testTasksShowTheLastJobsBeforeTheyLoad() async {
        let cache = makeCache()
        let firstVisit = TasksViewModel(server: server, client: makeClient { request in
            switch request.url?.path {
            case "/api/crons": return apiTestJSONResponse(#"{"jobs": [{"id": "job1", "name": "Digest"}]}"#, for: request)
            case "/api/crons/status": return apiTestJSONResponse("{}", for: request)
            default: return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            }
        }, responseCache: cache)
        await firstVisit.load()

        let nextVisit = TasksViewModel(server: server, client: offlineClient(), responseCache: cache)

        XCTAssertEqual(nextVisit.jobs.compactMap(\.jobId), ["job1"])
    }

    func testSkillsShowTheLastListBeforeItLoads() async {
        let cache = makeCache()
        let firstVisit = SkillsViewModel(client: makeClient { request in
            apiTestJSONResponse(#"{"skills": [{"name": "writer", "category": "docs"}]}"#, for: request)
        }, responseCache: cache)
        await firstVisit.load()

        let nextVisit = SkillsViewModel(client: offlineClient(), responseCache: cache)

        XCTAssertEqual(nextVisit.skills.compactMap(\.name), ["writer"])
    }

    func testMemoryShowsTheLastNotesButWaitsForTheServerBeforeEditing() async {
        let cache = makeCache()
        let firstVisit = MemoryViewModel(server: server, client: makeClient { request in
            apiTestJSONResponse(#"{"memory": "Saved notes", "user": "", "soul": ""}"#, for: request)
        }, responseCache: cache)
        await firstVisit.load()

        let nextVisit = MemoryViewModel(server: server, client: makeClient { request in
            apiTestJSONResponse(#"{"memory": "Newer notes", "user": "", "soul": ""}"#, for: request)
        }, responseCache: cache)

        XCTAssertEqual(nextVisit.content(for: .memory), "Saved notes")
        XCTAssertTrue(nextVisit.hasLoaded)
        XCTAssertTrue(nextVisit.isShowingCachedContent, "Editing stays off until the server's copy arrives")

        await nextVisit.load()

        XCTAssertEqual(nextVisit.content(for: .memory), "Newer notes")
        XCTAssertFalse(nextVisit.isShowingCachedContent)
    }
}
