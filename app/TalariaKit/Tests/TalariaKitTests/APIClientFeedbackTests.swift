import XCTest
@testable import TalariaKit

final class APIClientFeedbackTests: APIClientTestCase {
    func testFeedbackFailuresUseServiceSpecificMessages() {
        XCTAssertEqual(APIError.http(statusCode: 503, body: "{\"error\":\"feedback_unavailable\"}").localizedDescription,
                       "The feedback service is unavailable. Try again later.")
        XCTAssertEqual(APIError.http(statusCode: 502, body: "{\"error\":\"relay_unreachable\"}").localizedDescription,
                       "The Relay feedback service could not complete the request. Try again later.")
        for status in [502, 503, 504] {
            XCTAssertEqual(APIError.http(statusCode: status, body: "<html>Bad gateway</html>").localizedDescription,
                           "The Talaria server is unavailable. Check that it is running and that your network connection is working.")
        }
    }

    @MainActor
    func testHeldFeedbackRetryKeepsItsOriginalServersHeadersAfterSwitching() async throws {
        let previousHook = UITestURLSessionHook.configure
        let previousHeaders = CustomHeaderStore.shared.snapshot()
        defer {
            UITestURLSessionHook.configure = previousHook
            CustomHeaderStore.shared.replace(with: previousHeaders)
        }
        let firstStarted = expectation(description: "Server A holds the first feedback request")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let lock = NSLock()
        var requests: [URLRequest] = []
        let scope = MockURLProtocol.register { request in
            let count = lock.withLock { requests.append(request); return requests.count }
            if count == 1 {
                firstStarted.fulfill()
                guard release.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
                throw URLError(.networkConnectionLost)
            }
            if request.url?.path == "/api/feedback/diagnostics" {
                return apiTestJSONResponse("{\"text\":\"synthetic\",\"bytes\":9}", for: request)
            }
            return apiTestJSONResponse("{\"status\":\"sent\",\"reportId\":\"synthetic-report\"}", for: request)
        }
        UITestURLSessionHook.configure = { configuration in
            configuration.protocolClasses = [MockURLProtocol.self]
            configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: scope]
        }
        let suite = "FeedbackHeaderTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let server = URL(string: "https://feedback-\(UUID().uuidString.lowercased()).example.test")!
        CustomHeaderStore.shared.replace(with: [CustomHeader(name: "Authorization", value: "Bearer server-a")])
        let model = FeedbackComposer(server: server, defaults: defaults,
            clientMetadata: FeedbackClient(appVersion: "1", osVersion: "27", deviceModel: "synthetic"))
        model.edit { $0.title = "Synthetic feedback"; $0.body = "Synthetic details" }
        let task = try XCTUnwrap(model.send())
        await fulfillment(of: [firstStarted], timeout: 5)
        CustomHeaderStore.shared.replace(with: [CustomHeader(name: "Authorization", value: "Bearer server-b")])
        release.signal()
        await task.value
        await model.loadDiagnostics()
        let captured = lock.withLock { requests }
        XCTAssertEqual(captured.count, 3)
        XCTAssertTrue(captured.allSatisfy { $0.url?.host == server.host })
        XCTAssertEqual(captured.map { $0.value(forHTTPHeaderField: "Authorization") },
                       Array(repeating: "Bearer server-a", count: 3), "Server B's credentials must never reach server A")
    }

    func testFeedbackPathsMethodsPayloadAndResponses() async throws {
        let requestID = UUID()
        let client = makeClient { request in
            if request.url?.path == "/api/feedback/diagnostics" {
                XCTAssertEqual(request.httpMethod, "GET")
                return apiTestJSONResponse("{\"text\":\"verbatim\\n diagnostics\",\"bytes\":21,\"future\":true}", for: request)
            }
            XCTAssertEqual(request.url?.path, "/api/feedback/submit")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try apiTestJSONBody(from: request)
            XCTAssertEqual(body["requestId"] as? String, requestID.uuidString)
            XCTAssertEqual(body["kind"] as? String, "feature")
            XCTAssertEqual(body["title"] as? String, "A title")
            XCTAssertEqual(body["body"] as? String, "Details")
            XCTAssertEqual(body["includeDiagnostics"] as? Bool, false)
            let metadata = try XCTUnwrap(body["client"] as? [String: String])
            XCTAssertEqual(metadata, ["platform": "ios", "appVersion": "1.2 (3)", "osVersion": "27", "deviceModel": "iPhone99,1"])
            return apiTestJSONResponse("{\"status\":\"sent\",\"reportId\":\"synthetic-report\",\"future\":true}", for: request)
        }
        let diagnostics = try await client.feedbackDiagnostics()
        XCTAssertEqual(diagnostics.text, "verbatim\n diagnostics")
        let result = try await client.submitFeedback(.init(requestId: requestID, kind: "feature", title: "A title", body: "Details", includeDiagnostics: false, client: .init(appVersion: "1.2 (3)", osVersion: "27", deviceModel: "iPhone99,1")))
        XCTAssertEqual(result.status, "sent")
        XCTAssertEqual(result.reportId, "synthetic-report")
    }
}
