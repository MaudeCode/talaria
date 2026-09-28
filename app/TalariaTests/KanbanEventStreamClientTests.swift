import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
final class KanbanEventStreamClientTests: XCTestCase {
    override func tearDown() {
        RedirectingMockURLProtocol.reset()
        super.tearDown()
    }

    func testDecodesHandshakeAndEventsFrameWithResumeID() {
        XCTAssertEqual(
            KanbanStreamFrameDecoder.decode(
                eventType: "hello",
                data: #"{"cursor":7,"board":"main","future":true}"#,
                frameID: nil
            ),
            .hello(cursor: 7, board: "main")
        )

        let frame = KanbanStreamFrameDecoder.decode(
            eventType: "events",
            data: #"{"events":[{"id":8,"task_id":"CARD-8","kind":"future_kind","payload":{"private":"value"},"created_at":1700000000}],"cursor":8,"future":true}"#,
            frameID: "8"
        )
        guard case let .events(events, cursor, frameID) = frame else {
            return XCTFail("Expected events frame, got \(frame)")
        }
        XCTAssertEqual(cursor, 8)
        XCTAssertEqual(frameID, 8)
        XCTAssertEqual(events.first?.eventID, 8)
        XCTAssertEqual(events.first?.cardID, "CARD-8")
        XCTAssertEqual(events.first?.kind, "future_kind")
    }

    func testMalformedKnownFramesDoNotAdvanceAndUnknownTypesAreIgnored() {
        for frame in [
            KanbanStreamFrameDecoder.decode(eventType: "hello", data: #"{"cursor":-1,"board":"main"}"#, frameID: nil),
            KanbanStreamFrameDecoder.decode(eventType: "hello", data: #"{"cursor":1,"board":" "}"#, frameID: nil),
            KanbanStreamFrameDecoder.decode(eventType: "events", data: #"{"events":[],"cursor":"bad"}"#, frameID: nil),
            KanbanStreamFrameDecoder.decode(eventType: "events", data: #"{"events":[],"cursor":2}"#, frameID: "bad"),
            KanbanStreamFrameDecoder.decode(eventType: "events", data: "not json", frameID: nil)
        ] {
            XCTAssertEqual(frame, .malformed)
        }
        XCTAssertEqual(
            KanbanStreamFrameDecoder.decode(eventType: "future-frame", data: #"{"payload":"ignored"}"#, frameID: "9"),
            .ignored
        )
    }

    func testSSECommentsAreTransportKeepalives() {
        // LDSwiftEventSource delivers comment lines through EventHandler.onComment,
        // which KanbanEventStreamClient intentionally treats as a no-op. The
        // decoder therefore never receives or misclassifies keepalive payloads.
        XCTAssertEqual(
            KanbanStreamFrameDecoder.decode(eventType: "", data: "", frameID: nil),
            .ignored
        )
    }

    func testKanbanSSEProtectsHeadersOnCrossOriginRedirect() async throws {
        let streamURL = try XCTUnwrap(URL(string: "https://example.test/api/kanban/events"))
        let cookieStorage = ServerCookieStore.shared.storage(for: streamURL)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "example.test", .path: "/", .name: "hermes_session", .value: "secret-cookie"
        ]))
        cookieStorage.setCookie(cookie)
        defer { cookieStorage.deleteCookie(cookie) }
        RedirectingMockURLProtocol.redirect = .init(
            fromPath: "/api/kanban/events",
            to: URL(string: "https://third-party.example/final")!
        )
        RedirectingMockURLProtocol.responseData = Data(
            "event: hello\ndata: {\"cursor\":0,\"board\":\"main\"}\n\n".utf8
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedirectingMockURLProtocol.self]
        let client = KanbanEventStreamClient(
            urlSessionConfiguration: configuration,
            customHeaderProvider: {
                [
                    CustomHeader(name: "Accept", value: "application/json"),
                    CustomHeader(name: "X-Api-Key", value: "secret"),
                    CustomHeader(name: "x-talaria-client", value: "forged identity"),
                    CustomHeader(name: "X-Talaria-Redirect-Policy", value: "user-value")
                ]
            }
        )
        let received = expectation(description: "received redirected Kanban stream")

        client.start(
            url: streamURL,
            onFrame: { frame in
                if frame == .hello(cursor: 0, board: "main") { received.fulfill() }
            },
            onFailure: {}
        )

        await fulfillment(of: [received], timeout: 5)
        client.stop()

        let firstHop = try XCTUnwrap(RedirectingMockURLProtocol.firstHopRequest)
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Api-Key"), "secret")
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Talaria-Redirect-Policy"), "user-value")
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "Cookie"), "hermes_session=secret-cookie")
        XCTAssertFalse(firstHop.hasInternalRedirectPolicyHeader)

        let secondHop = try XCTUnwrap(RedirectingMockURLProtocol.secondHopRequest)
        XCTAssertEqual(secondHop.url?.host, "third-party.example")
        XCTAssertEqual(secondHop.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "X-Api-Key"))
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "X-Talaria-Client"))
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "X-Talaria-Redirect-Policy"))
        XCTAssertNil(secondHop.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(secondHop.hasInternalRedirectPolicyHeader)
    }

    func testKanbanSSEKeepsCustomHeaderOnSameOriginRedirect() async throws {
        RedirectingMockURLProtocol.redirect = .init(
            fromPath: "/api/kanban/events",
            to: URL(string: "https://example.test/final")!
        )
        RedirectingMockURLProtocol.responseData = Data(
            "event: hello\ndata: {\"cursor\":0,\"board\":\"main\"}\n\n".utf8
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedirectingMockURLProtocol.self]
        let client = KanbanEventStreamClient(
            urlSessionConfiguration: configuration,
            customHeaderProvider: { [CustomHeader(name: "X-Api-Key", value: "secret")] }
        )
        let received = expectation(description: "received same-origin redirected Kanban stream")

        client.start(
            url: URL(string: "https://example.test/api/kanban/events")!,
            onFrame: { frame in
                if frame == .hello(cursor: 0, board: "main") { received.fulfill() }
            },
            onFailure: {}
        )

        await fulfillment(of: [received], timeout: 5)
        client.stop()

        let firstHop = try XCTUnwrap(RedirectingMockURLProtocol.firstHopRequest)
        XCTAssertEqual(firstHop.value(forHTTPHeaderField: "X-Api-Key"), "secret")
        XCTAssertFalse(firstHop.hasInternalRedirectPolicyHeader)
        let secondHop = try XCTUnwrap(RedirectingMockURLProtocol.secondHopRequest)
        XCTAssertEqual(secondHop.value(forHTTPHeaderField: "X-Api-Key"), "secret")
        XCTAssertFalse(secondHop.hasInternalRedirectPolicyHeader)
    }

    func testKanbanSSEClientDeinitUnregistersRedirectPolicy() {
        let initialCount = CrossOriginRedirectGuardURLProtocol.registeredPolicyCount
        var client: KanbanEventStreamClient? = KanbanEventStreamClient(urlSessionConfiguration: .ephemeral)
        weak let weakClient = client

        client?.start(
            url: URL(string: "https://example.test/api/kanban/events")!,
            onFrame: { _ in },
            onFailure: {}
        )
        XCTAssertEqual(CrossOriginRedirectGuardURLProtocol.registeredPolicyCount, initialCount + 1)
        client = nil

        XCTAssertNil(weakClient)
        XCTAssertEqual(CrossOriginRedirectGuardURLProtocol.registeredPolicyCount, initialCount)
    }
}
