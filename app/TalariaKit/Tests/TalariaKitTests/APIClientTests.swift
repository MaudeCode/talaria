import XCTest
@testable import TalariaKit

final class MockURLProtocolScopeTests: APIClientTestCase {
    func testScopedHandlerOutlivesGlobalHandlerReplacement() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [
            MockURLProtocol.scopeHeader: MockURLProtocol.register { request in
                apiTestJSONResponse(#"{"session":{"session_id":"scoped"}}"#, for: request)
            }
        ]
        let client = APIClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration))

        // The next test's handler must not see this session's request.
        MockURLProtocol.requestHandler = { request in
            XCTFail("Scoped request leaked to the global handler: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let response = try await client.session(id: "scoped", includeMessages: false, messageLimit: nil)
        XCTAssertEqual(response.session?.sessionId, "scoped")

        // Registering many later sessions evicts this scope, so the retained
        // closure count stays bounded and the stale session fails cleanly.
        for _ in 0..<16 {
            _ = MockURLProtocol.register { _ in throw URLError(.badURL) }
        }
        do {
            _ = try await client.session(id: "scoped", includeMessages: false, messageLimit: nil)
            XCTFail("Evicted scope should not be served")
        } catch APIError.network(let underlying) {
            XCTAssertEqual((underlying as? URLError)?.code, .badServerResponse)
        }
    }
}
