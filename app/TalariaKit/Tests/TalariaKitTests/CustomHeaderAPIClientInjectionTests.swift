import XCTest
@testable import TalariaKit

// MARK: - APIClient request injection

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

    func testJSONRequestCarriesCustomHeadersAndBuiltInsWin() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer abc"),
            CustomHeader(name: "X-Api-Key", value: "k1"),
            CustomHeader(name: "Accept", value: "application/evil")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Api-Key"), "k1")
            // Built-in Accept is set after the custom headers, so it wins its key.
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            return try self.ok(request)
        }

        _ = try? await client.sessions()
    }

    func testEmptyHeaderListIsANoOp() async throws {
        let (client, _) = makeHeaderClient([]) { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            return try self.ok(request)
        }

        _ = try? await client.sessions()
    }

    func testWhitespaceOnlyHeaderNameIsSkipped() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "   ", value: "ghost"),
            CustomHeader(name: "X-Real", value: "ok")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Real"), "ok")
            // The blank-named row contributes nothing.
            XCTAssertEqual(request.allHTTPHeaderFields?.values.contains("ghost"), false)
            return try self.ok(request)
        }

        _ = try? await client.sessions()
    }

    func testUploadRequestCarriesCustomHeadersAndMultipartContentTypeWins() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer upload"),
            CustomHeader(name: "Content-Type", value: "application/evil")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer upload")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            // The built-in multipart Content-Type is set after the custom
            // headers, so it wins its key.
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary="),
                true
            )
            return try self.ok(request)
        }

        _ = try? await client.uploadFile(sessionID: "s1", data: Data("bytes".utf8), filename: "a.png")
    }

    func testTranscribeRequestCarriesCustomHeaders() async throws {
        let (client, _) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer stt")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer stt")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            return try self.ok(request)
        }

        _ = try? await client.transcribeAudio(data: Data("clip".utf8), filename: "v.m4a")
    }

    func testDownloadRequestCarriesCustomHeaders() async throws {
        let (client, session) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer media")
        ]) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer media")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "*/*")
            return try self.ok(request, body: "binary")
        }

        _ = try? await client.downloadData(
            from: URL(string: "https://example.test/api/media?path=/x.png")!,
            using: session,
            mapsUnauthorized: false
        )
    }

    func testDownloadFromExternalOriginOmitsCustomHeaders() async throws {
        let (client, session) = makeHeaderClient([
            CustomHeader(name: "Authorization", value: "Bearer secret")
        ]) { request in
            // A third-party transcript image must never receive the (possibly
            // secret) custom headers — off-origin leak guard.
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Talaria-Client"))
            return try self.ok(request, body: "img")
        }

        _ = try? await client.downloadData(
            from: URL(string: "https://third-party.example/image.png")!,
            using: session,
            mapsUnauthorized: false
        )
    }
}
