import XCTest
@testable import TalariaKit

final class APIClientFeedbackTests: APIClientTestCase {
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
