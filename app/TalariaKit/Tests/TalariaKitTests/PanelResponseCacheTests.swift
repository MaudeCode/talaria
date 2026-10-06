import XCTest
@testable import TalariaKit

// TAL-437: Tasks, Skills and Memory show their last content on the next visit or launch, then
// update from the server.
@MainActor
final class PanelResponseCacheTests: XCTestCase {
    // A server of its own per test, so the recorded active profile is test-owned.
    private let server = URL(string: "https://\(UUID().uuidString.lowercased()).test")!

    private func makeCache() -> ResponseCache {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { [server] in
            try? FileManager.default.removeItem(at: root)
            ActiveServerProfile.record(nil, for: server)
        }
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

    // TAL-553: Memory and Tasks come from the active profile's home, so a profile switch must not
    // show the previous profile's cached copy; switching back shows its own copy at once.
    func testMemoryAndTasksNeverShowAnotherProfilesCachedCopy() async throws {
        let cache = makeCache()
        let profileA = makeClient { request in
            switch request.url?.path {
            case "/api/profiles": return apiTestJSONResponse(#"{"active": "alpha", "profiles": [{"name": "alpha"}, {"name": "beta"}]}"#, for: request)
            case "/api/memory": return apiTestJSONResponse(#"{"memory": "Alpha notes", "user": "", "soul": ""}"#, for: request)
            case "/api/crons": return apiTestJSONResponse(#"{"jobs": [{"id": "alpha-job", "name": "Digest"}]}"#, for: request)
            case "/api/crons/status": return apiTestJSONResponse("{}", for: request)
            default: return apiTestJSONResponse(#"{"platforms": []}"#, for: request)
            }
        }
        _ = try await profileA.profiles()
        await MemoryViewModel(server: server, client: profileA, responseCache: cache).load()
        await TasksViewModel(server: server, client: profileA, responseCache: cache).load()

        let switcher = makeClient { request in
            let name = apiTestBodyData(from: request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["name"]
            return apiTestJSONResponse(#"{"active": "\#(name ?? "")"}"#, for: request)
        }
        _ = try await switcher.switchProfile(name: "beta")

        let memoryForB = MemoryViewModel(server: server, client: offlineClient(), responseCache: cache)
        let tasksForB = TasksViewModel(server: server, client: offlineClient(), responseCache: cache)
        XCTAssertEqual(memoryForB.content(for: .memory), "", "Profile beta must not show alpha's cached memory")
        XCTAssertEqual(tasksForB.jobs.compactMap(\.jobId), [], "Profile beta must not show alpha's cached jobs")

        _ = try await switcher.switchProfile(name: "alpha")

        XCTAssertEqual(
            MemoryViewModel(server: server, client: offlineClient(), responseCache: cache).content(for: .memory),
            "Alpha notes"
        )
        XCTAssertEqual(
            TasksViewModel(server: server, client: offlineClient(), responseCache: cache).jobs.compactMap(\.jobId),
            ["alpha-job"]
        )
    }
}
