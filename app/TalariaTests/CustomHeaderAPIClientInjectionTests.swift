import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of CustomHeaderAPIClientInjectionTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class CustomHeaderAPIClientInjectionTests: APIClientTestCase {
    private func makeHeaderClient(
        _ customHeaders: [CustomHeader],
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> (client: APIClient, session: URLSession) {
        MockURLProtocol.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)

        let client = APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            customHeaderProvider: { customHeaders }
        )
        return (client, session)
    }

    private func ok(_ request: URLRequest, body: String = "{}") throws -> (HTTPURLResponse, Data) {
        let response = try XCTUnwrap(
            HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)
        )
        return (response, Data(body.utf8))
    }

    func testRequestsAdvertiseReleaseIdentityWithoutCustomHeaderSecrets() async throws {
        let (client, _) = makeHeaderClient([CustomHeader(name: "Authorization", value: "Bearer synthetic-secret")]) { request in
            let value = try XCTUnwrap(request.value(forHTTPHeaderField: "X-Talaria-Client"))
            let identity = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
            XCTAssertEqual(identity["version"] as? String, Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
            XCTAssertEqual(identity["buildNumber"] as? String, Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
            XCTAssertTrue(identity["sourceRevision"] is NSNull)
            XCTAssertTrue(identity["releaseSet"] is NSNull)
            // The versions themselves are owned by TalariaKit `testAppAdvertisesCanonicalContractVersions`.
            XCTAssertNotNil(identity["contracts"] as? [String: Any])
            XCTAssertFalse(value.contains("synthetic-secret"))
            return try self.ok(request)
        }
        _ = try? await client.sessions()
    }
}
