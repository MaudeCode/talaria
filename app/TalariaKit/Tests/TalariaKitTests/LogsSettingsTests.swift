import Foundation
import XCTest
@testable import TalariaKit

final class LogsResponseTests: APIClientTestCase {
    func testLogsRequestAndTolerantPayloads() async throws {
        let payloads = [
            #"{"file":"webui","lines":["first","  continuation","last"],"total_bytes":8192,"mtime":1794477600,"truncated":true,"files":[{"id":"webui","exists":true}],"future":{"anything":1}}"#,
            #"{"file":"webui","lines":[],"hint":"No log yet","mtime":null}"#,
            #"{}"#
        ]
        for (index, payload) in payloads.enumerated() {
            let client = makeClient { request in
                XCTAssertEqual(request.url?.path, "/api/logs")
                XCTAssertEqual(request.httpMethod, "GET")
                let items = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
                XCTAssertEqual(Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") }), ["file": "webui", "tail": "2000"])
                return apiTestJSONResponse(payload, for: request)
            }
            let result = try await client.logs(file: "webui", tail: 2000)
            if index == 0 {
                XCTAssertEqual(result.lines, ["first", "  continuation", "last"])
                XCTAssertEqual(result.totalBytes, 8192)
                XCTAssertEqual(result.mtime, 1794477600)
                XCTAssertEqual(result.truncated, true)
                XCTAssertEqual(result.files?.map(\.id), ["webui"])
            } else {
                XCTAssertEqual(result.lines, [])
                XCTAssertNil(result.mtime)
                XCTAssertEqual(result.hint, index == 1 ? "No log yet" : nil)
            }
        }
    }
}

@MainActor
final class LogsSettingsModelTests: APIClientTestCase {
    func testFollowRefreshesAtFifteenSecondsAndStopsWhenInactiveOrCancelled() async throws {
        let reads = LockedTestValue(0)
        let client = makeClient { request in
            reads.value += 1
            return apiTestJSONResponse(#"{"file":"agent","lines":["first","last"]}"#, for: request)
        }
        let model = LogsSettingsModel(client: client)
        await model.follow(isActive: false, clock: LogsTestClock { _ in XCTFail("Inactive pages must not start a clock") })
        XCTAssertEqual(reads.value, 0)
        var ticks = 0
        await model.follow(isActive: true, clock: LogsTestClock { interval in
            XCTAssertEqual(interval, .seconds(15))
            XCTAssertEqual(reads.value, ticks + 1, "Refresh before waiting, then once per clock tick")
            ticks += 1
            if ticks == 3 { throw CancellationError() }
        })
        XCTAssertEqual(reads.value, 3)
        XCTAssertEqual(model.text, "first\nlast", "Share and the log view use the same unmodified text")
        let stopped = Task { await model.follow(isActive: true, clock: ContinuousClock()) }
        stopped.cancel()
        await stopped.value
        XCTAssertEqual(reads.value, 3, "A hidden page's cancelled owner cannot issue another read")
    }

    func testLateReplyCannotReplaceANewerFileSelection() async throws {
        let host = "logs-\(UUID().uuidString).test"
        let held = DeferredRequests()
        let first = expectation(description: "old file held")
        DeferredMockURLProtocol.setOnRequest({ request in
            if held.append(request) == 1 { first.fulfill() }
            else { request.complete(withJSON: #"{"lines":["new file"]}"#) }
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let model = LogsSettingsModel(client: APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config)))
        let old = Task { await model.load() }
        await fulfillment(of: [first], timeout: 5)
        model.file = "webui"
        await model.load()
        held.request(at: 0).complete(withJSON: #"{"lines":["old file"]}"#)
        await old.value
        XCTAssertEqual(model.text, "new file", "Late reads must not restore another file's tail or share text")
        XCTAssertFalse(model.isLoading)
    }

    func testNewSelectionClearsOldTextAndErrorAndReloadRecovers() async throws {
        let fails = LockedTestValue(false)
        let client = makeClient { request in
            if fails.value { return apiTestJSONResponse(#"{"error":"Log access is restricted"}"#, statusCode: 403, for: request) }
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
            return apiTestJSONResponse("{\"lines\":[\"\(values["file"]!):\(values["tail"]!)\"]}", for: request)
        }
        let model = LogsSettingsModel(client: client)
        await model.load()
        XCTAssertEqual(model.text, "agent:500")
        fails.value = true
        await model.load()
        XCTAssertTrue(model.errorMessage?.contains("Log access is restricted") == true)
        XCTAssertEqual(model.text, "agent:500", "A failed refresh retains the shown tail")
        model.file = "bootstrap"
        XCTAssertEqual(model.text, "", "Do not share another file's stale tail")
        XCTAssertNil(model.errorMessage)
        model.tail = 200
        fails.value = false
        await model.load()
        XCTAssertEqual(model.text, "bootstrap:200")
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isLoading)
    }
}

/// Advances only when the test releases the requested deadline.
private struct LogsTestClock: Clock {
    private let instant = LockedTestValue(ContinuousClock.now)
    var now: ContinuousClock.Instant { instant.value }
    var minimumResolution: Duration { .nanoseconds(1) }
    let tick: @MainActor @Sendable (Duration) async throws -> Void

    init(tick: @escaping @MainActor @Sendable (Duration) async throws -> Void) { self.tick = tick }

    func sleep(until deadline: ContinuousClock.Instant, tolerance: Duration?) async throws {
        try await tick(now.duration(to: deadline))
        instant.value = deadline
    }
}
