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

    func testFeedbackAttachmentUploadOptionsAndPerAttachmentResults() async throws {
        let staged = UUID(), refused = UUID()
        let file = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/feedback/options":
                XCTAssertEqual(request.httpMethod, "GET")
                return apiTestJSONResponse(#"{"attachments":{"enabled":true,"videoAllowed":false,"maxCount":5,"maxImageBytes":10000000,"maxVideoBytes":20000000,"maxVideoSeconds":120,"acceptedTypes":["image/png","image/jpeg"],"future":1}}"#, for: request)
            case "/api/feedback/attachments":
                XCTAssertEqual(request.httpMethod, "POST")
                let type = try XCTUnwrap(request.value(forHTTPHeaderField: "Content-Type"))
                XCTAssertTrue(type.hasPrefix("multipart/form-data; boundary="))
                let boundary = String(type.dropFirst("multipart/form-data; boundary=".count))
                let body = try XCTUnwrap(apiTestBodyData(from: request))
                let text = String(decoding: body, as: UTF8.self)
                XCTAssertTrue(text.contains("--\(boundary)\r\nContent-Disposition: form-data; name=\"contentType\"\r\n\r\nimage/png\r\n"))
                XCTAssertTrue(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"screen.png\""))
                XCTAssertNotNil(body.range(of: file), "The compressed bytes are sent unchanged")
                XCTAssertTrue(text.hasSuffix("--\(boundary)--\r\n"))
                return apiTestJSONResponse(#"{"attachmentId":"\#(staged.uuidString)","contentType":"image/png","bytes":8}"#, for: request)
            default:
                XCTAssertEqual(request.url?.path, "/api/feedback/submit")
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual(body["attachmentIds"] as? [String], [staged.uuidString, refused.uuidString])
                return apiTestJSONResponse(#"{"status":"sent","reportId":"r","attachments":[{"attachmentId":"\#(staged.uuidString)","status":"sent"},{"attachmentId":"\#(refused.uuidString)","status":"refused","reason":"tier"}]}"#, for: request)
            }
        }
        let options = try await client.feedbackOptions().attachments
        XCTAssertEqual(options, .init(enabled: true, videoAllowed: false, maxCount: 5, maxImageBytes: 10_000_000,
                                      maxVideoBytes: 20_000_000, maxVideoSeconds: 120, acceptedTypes: ["image/png", "image/jpeg"]))
        let uploaded = try await client.uploadFeedbackAttachment(file, contentType: "image/png", filename: "screen.png")
        XCTAssertEqual(uploaded, .init(attachmentId: staged, contentType: "image/png", bytes: 8))
        let result = try await client.submitFeedback(.init(title: "t", body: "b", client: .init(appVersion: "1", osVersion: "27", deviceModel: "x"),
                                                           attachmentIds: [staged, refused]))
        XCTAssertEqual(result.attachments, [.init(attachmentId: staged, status: "sent"),
                                            .init(attachmentId: refused, status: "refused", reason: "tier")])
    }

    func testFeedbackWithoutAttachmentsOmitsTheirIDs() async throws {
        let client = makeClient { request in
            let body = try apiTestJSONBody(from: request)
            XCTAssertNil(body["attachmentIds"], "The contract requires at least one ID when the field is present")
            return apiTestJSONResponse(#"{"status":"sent","reportId":"r"}"#, for: request)
        }
        let result = try await client.submitFeedback(.init(title: "t", body: "b"))
        XCTAssertEqual(result.attachments, [], "A server without attachments still decodes")
    }

    func testFeedbackUploadRefusalsSurfaceTheServerError() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"error":"attachments_unavailable"}"#, statusCode: 403, for: request)
        }
        do {
            _ = try await client.uploadFeedbackAttachment(Data([1]), contentType: "image/png", filename: "a.png")
            XCTFail("A refused upload must throw")
        } catch let APIError.http(statusCode, _) {
            XCTAssertEqual(statusCode, 403)
        }
    }
}
