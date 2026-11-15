import XCTest
@testable import TalariaKit

/// Clients built without an injected session reuse one warm connection pool per
/// server and one process-wide media session, while each server keeps its own
/// cookie jar (TAL-847).
final class APIClientSharedSessionTests: XCTestCase {
    private func uniqueServer(port: Int) throws -> URL {
        try XCTUnwrap(URL(string: "https://shared-\(UUID().uuidString.lowercased()).test:\(port)"))
    }

    func testClientsForOneServerShareOneDefaultSessionAndEveryClientSharesTheMediaSession() async throws {
        let serverA = try uniqueServer(port: 8443)
        let serverB = try uniqueServer(port: 9443)
        defer {
            ServerCookieStore.shared.clear(for: serverA)
            ServerCookieStore.shared.clear(for: serverB)
        }
        var sessionsA: [URLSession] = []
        for _ in 0..<3 {
            let client = APIClient(baseURL: serverA)
            sessionsA += [await client.session, await client.publicMediaSession]
        }
        let clientB = APIClient(baseURL: serverB)
        let defaultB = await clientB.session
        let mediaB = await clientB.publicMediaSession

        XCTAssertEqual(Set(sessionsA.map(ObjectIdentifier.init)).count, 2,
                       "three clients for one server use one default and one media session")
        XCTAssertTrue(mediaB === sessionsA[1], "every client shares the media session")
        XCTAssertFalse(defaultB === sessionsA[0], "each server keeps its own default session")
        XCTAssertTrue(sessionsA[0].configuration.httpCookieStorage === ServerCookieStore.shared.storage(for: serverA))
    }

    func testSharedSessionsKeepCookiesPerServerPortAndClearOnlyTheClearedServer() async throws {
        // `/health` sets the server's session cookie; `/api/auth/status` only records it.
        func server(_ name: String) throws -> LoopbackHTTPServer {
            try LoopbackHTTPServer { request in
                var response = LoopbackHTTPServer.Response.json(#"{"status":"ok"}"#)
                if request.path == "/health" { response.headers["Set-Cookie"] = "hermes_session=\(name); Path=/" }
                return response
            }
        }
        let serverA = try server("a")
        let serverB = try server("b")
        defer {
            ServerCookieStore.shared.clear(for: serverA.baseURL)
            ServerCookieStore.shared.clear(for: serverB.baseURL)
        }
        func request(_ endpoint: Endpoint, on server: LoopbackHTTPServer) async throws {
            _ = try await APIClient(baseURL: server.baseURL, customHeaderProvider: { [] })
                .sendData(endpoint: endpoint, method: "GET")
        }

        try await request(.health, on: serverA)
        try await request(.authStatus, on: serverA)
        try await request(.authStatus, on: serverB)
        XCTAssertEqual(serverA.requests.last?.header("Cookie"), "hermes_session=a")
        XCTAssertNil(serverB.requests.last?.header("Cookie"), "server A's cookie reached server B on another port")

        try await request(.health, on: serverB)
        ServerCookieStore.shared.clear(for: serverA.baseURL)
        try await request(.authStatus, on: serverA)
        try await request(.authStatus, on: serverB)

        XCTAssertNil(serverA.requests.last?.header("Cookie"), "clearing server A left its cookie in the shared session")
        XCTAssertEqual(serverB.requests.last?.header("Cookie"), "hermes_session=b")
    }

    func testSharedDefaultAndMediaSessionsStripCustomHeadersOnCrossOriginRedirect() async throws {
        let destination = try LoopbackHTTPServer { _ in LoopbackHTTPServer.Response(status: 200, body: Data("img".utf8)) }
        let origin = try LoopbackHTTPServer { _ in .redirect(302, to: destination.url("/image.png")) }
        defer { ServerCookieStore.shared.clear(for: origin.baseURL) }
        let client = APIClient(baseURL: origin.baseURL, customHeaderProvider: {
            [CustomHeader(name: "X-Api-Key", value: "k1")]
        })

        for (name, session) in [("default", await client.session), ("media", await client.publicMediaSession)] {
            let data = try await client.downloadData(from: origin.url("/api/media"), using: session, mapsUnauthorized: false)

            XCTAssertEqual(data, Data("img".utf8), name)
            XCTAssertEqual(origin.requests.last?.header("X-Api-Key"), "k1", name)
            let hop = try XCTUnwrap(destination.requests.last, name)
            XCTAssertNil(hop.header("X-Api-Key"), name)
            XCTAssertNil(hop.header(AppConfig.clientIdentityHeaderName), name)
        }
        XCTAssertEqual(destination.requests.count, 2)
    }

    func testInjectedSessionIsUsedAndNotInvalidatedWhenTheClientIsReleased() async throws {
        let destination = try LoopbackHTTPServer { _ in .json(#"{"status":"ok"}"#) }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        do {
            let client = APIClient(baseURL: destination.baseURL, session: session, publicMediaSession: session)
            let resolvedSession = await client.session
            let resolvedMediaSession = await client.publicMediaSession
            XCTAssertTrue(resolvedSession === session)
            XCTAssertTrue(resolvedMediaSession === session)
        }

        let (_, response) = try await session.data(from: destination.url("/api/health"))

        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
}
