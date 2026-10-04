import XCTest
@testable import TalariaKit

/// TAL-176: a row the list adds locally — a new chat, a duplicate, a deep-linked
/// session — survives a session-list response that was requested before it.
@MainActor
extension SessionListMutationTests {
    func testCreatedSessionSurvivesAnEarlierListResponse() async throws {
        let host = "tal176-create.test"
        let listArrived = expectation(description: "stale sessions request arrived")
        let lists = DeferredRequests()

        DeferredMockURLProtocol.setOnRequest({ request in
            switch request.request.url?.path {
            case "/api/sessions":
                XCTAssertEqual(lists.append(request), 1, "unexpected extra sessions request")
                listArrived.fulfill()
            case "/api/workspaces":
                request.complete(withJSON: #"{"workspaces":[{"path":"/tmp/workspace"}],"last":"/tmp/workspace"}"#)
            case "/api/session/new":
                request.complete(withJSON: #"{"session":{"session_id":"new-1","title":"Fresh chat","archived":false}}"#)
            default:
                XCTFail("unexpected request \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeDeferredViewModel(host: host)

        let staleLoad = Task { await viewModel.load() }
        await fulfillment(of: [listArrived], timeout: 5)

        let created = await viewModel.createSession()
        XCTAssertEqual(created?.sessionId, "new-1")

        lists.request(at: 0).complete(withJSON: Self.listJSON(["old"]))
        _ = await staleLoad.value

        XCTAssertEqual(
            viewModel.sessions.compactMap(\.sessionId),
            ["new-1", "old"],
            "A list response requested before the new chat must not remove it."
        )
    }

    func testDuplicatedSessionSurvivesAnEarlierListResponse() async throws {
        let host = "tal176-duplicate.test"
        let staleListArrived = expectation(description: "stale sessions request arrived")
        let followUpArrived = expectation(description: "follow-up sessions request arrived")
        let lists = DeferredRequests()

        DeferredMockURLProtocol.setOnRequest({ request in
            switch request.request.url?.path {
            case "/api/sessions":
                switch lists.append(request) {
                case 1: staleListArrived.fulfill()
                case 2: followUpArrived.fulfill()
                default: XCTFail("unexpected extra sessions request")
                }
            case "/api/session/duplicate":
                request.complete(withJSON: #"{"session":{"session_id":"copy-1","title":"Planning (copy)","archived":false}}"#)
            default:
                XCTFail("unexpected request \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeDeferredViewModel(host: host)
        let source = try makeSessionSummary(id: "source", title: "Planning", pinned: false, archived: false)

        // The duplicate's own reload is coalesced into a follow-up of the load
        // already in flight, so the copy is inserted before that stale response.
        let staleLoad = Task { await viewModel.load() }
        await fulfillment(of: [staleListArrived], timeout: 5)

        let duplicated = await viewModel.duplicate(source)
        XCTAssertEqual(duplicated?.sessionId, "copy-1")

        lists.request(at: 0).complete(withJSON: Self.listJSON(["source"]))
        await fulfillment(of: [followUpArrived], timeout: 5)

        XCTAssertEqual(
            viewModel.sessions.compactMap(\.sessionId),
            ["copy-1", "source"],
            "A list response requested before the duplicate must not remove it."
        )

        // The follow-up was requested after the copy, so it is authoritative.
        lists.request(at: 1).complete(withJSON: Self.listJSON(["source", "copy-1"]))
        _ = await staleLoad.value
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["source", "copy-1"])
    }

    func testDeepLinkedSessionSurvivesAnEarlierListResponse() async throws {
        let host = "tal176-deep-link.test"
        let listArrived = expectation(description: "stale sessions request arrived")
        let lists = DeferredRequests()

        DeferredMockURLProtocol.setOnRequest({ request in
            switch request.request.url?.path {
            case "/api/sessions":
                XCTAssertEqual(lists.append(request), 1, "unexpected extra sessions request")
                listArrived.fulfill()
            case "/api/session":
                request.complete(withJSON: #"{"session":{"session_id":"linked","title":"Linked","archived":false}}"#)
            default:
                XCTFail("unexpected request \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeDeferredViewModel(host: host)

        let staleLoad = Task { await viewModel.load() }
        await fulfillment(of: [listArrived], timeout: 5)

        let linked = await viewModel.loadSessionForDeepLink(id: "linked")
        XCTAssertEqual(linked?.sessionId, "linked")

        lists.request(at: 0).complete(withJSON: Self.listJSON(["old"]))
        _ = await staleLoad.value

        XCTAssertEqual(
            viewModel.sessions.compactMap(\.sessionId),
            ["linked", "old"],
            "A list response requested before the deep link must not remove its row."
        )
    }

    /// Archiving or deleting the inserted row ends its claim: the earlier
    /// response must not bring back a chat the server has just removed.
    func testArchivedOrDeletedInsertIsNotRestoredByAnEarlierListResponse() async throws {
        for (host, removal) in [
            ("tal176-archive.test", "/api/session/archive"),
            ("tal176-delete.test", "/api/session/delete"),
        ] {
            let staleListArrived = expectation(description: "\(removal): stale sessions request arrived")
            let followUpArrived = expectation(description: "\(removal): follow-up sessions request arrived")
            let lists = DeferredRequests()

            DeferredMockURLProtocol.setOnRequest({ request in
                switch request.request.url?.path {
                case "/api/sessions":
                    switch lists.append(request) {
                    case 1: staleListArrived.fulfill()
                    case 2: followUpArrived.fulfill()
                    default: XCTFail("unexpected extra sessions request")
                    }
                case "/api/session":
                    request.complete(withJSON: #"{"session":{"session_id":"linked","title":"Linked","archived":false}}"#)
                case removal:
                    request.complete(withJSON: #"{"ok":true}"#)
                default:
                    XCTFail("unexpected request \(request.request.url?.path ?? "nil")")
                }
            }, forHost: host)
            defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

            let viewModel = try makeDeferredViewModel(host: host)

            let staleLoad = Task { await viewModel.load() }
            await fulfillment(of: [staleListArrived], timeout: 5)

            let linkedResult = await viewModel.loadSessionForDeepLink(id: "linked")
            let linked = try XCTUnwrap(linkedResult)
            let removed = if removal == "/api/session/archive" {
                await viewModel.archive(linked)
            } else {
                await viewModel.delete(linked)
            }
            XCTAssertTrue(removed)

            lists.request(at: 0).complete(withJSON: Self.listJSON(["old"]))
            await fulfillment(of: [followUpArrived], timeout: 5)

            XCTAssertEqual(
                viewModel.sessions.compactMap(\.sessionId),
                ["old"],
                "\(removal): an earlier list response must not restore a removed row."
            )

            lists.request(at: 1).complete(withJSON: Self.listJSON(["old"]))
            _ = await staleLoad.value
        }
    }

    private func makeDeferredViewModel(host: String) throws -> SessionListViewModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://\(host)"))
        let client = APIClient(baseURL: server, session: URLSession(configuration: configuration))
        return SessionListViewModel(server: server, client: client)
    }

    private static func listJSON(_ ids: [String]) -> String {
        let rows = ids.map { #"{"session_id":"\#($0)","title":"\#($0)","archived":false}"# }
        return #"{"sessions":[\#(rows.joined(separator: ","))]}"#
    }
}
