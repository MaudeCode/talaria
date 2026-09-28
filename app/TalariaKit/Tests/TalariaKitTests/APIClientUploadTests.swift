import XCTest
@testable import TalariaKit

final class APIClientUploadTests: APIClientTestCase {
    func testMultipartDispositionEscapesHostileFieldNameAndFilename() {
        var body = Data()
        body.appendMultipart(textField: "field%22\"\\\r\nInjected: yes", value: "value", boundary: "boundary")
        body.appendMultipart(
            fileField: "file%22\"\\\r\nInjected: yes",
            filename: "photo%22\"\\\r\nInjected: yes.jpg",
            data: Data(),
            boundary: "boundary"
        )

        let bodyString = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(bodyString.contains(#"name="field%2522%22%5C%0D%0AInjected: yes""#))
        XCTAssertTrue(bodyString.contains(#"name="file%2522%22%5C%0D%0AInjected: yes"; filename="photo%2522%22%5C%0D%0AInjected: yes.jpg""#))
        XCTAssertFalse(bodyString.contains("\r\nInjected: yes"))
    }

    /// A multipart *value* is sent verbatim, so a value carrying the active
    /// boundary could open another part. Nothing escapes that; what makes it
    /// unreachable is that every upload derives a fresh, unguessable boundary.
    /// `UntrustedInputFuzzTests` covers the escaped name and filename side.
    func testUploadBoundariesAreUnguessableAndUniquePerRequest() async throws {
        var boundaries: [String] = []
        let client = makeClient { request in
            let contentType = request.value(forHTTPHeaderField: "Content-Type") ?? ""
            boundaries.append(
                contentType.replacingOccurrences(of: "multipart/form-data; boundary=", with: "")
            )
            return apiTestJSONResponse("""
            {"filename": "a.txt", "path": "/tmp/workspace/a.txt", "size": 1}
            """, for: request)
        }

        for _ in 0..<2 {
            _ = try await client.uploadFile(sessionID: "abc123", data: Data("a".utf8), filename: "a.txt")
        }

        XCTAssertEqual(boundaries.count, 2)
        XCTAssertNotEqual(boundaries[0], boundaries[1], "Two uploads reused one multipart boundary.")
        for boundary in boundaries {
            XCTAssertTrue(boundary.hasPrefix("Boundary-"), "Unexpected boundary shape: \(boundary)")
            XCTAssertNotNil(
                UUID(uuidString: String(boundary.dropFirst("Boundary-".count))),
                "Upload boundary was not a UUID, so it is guessable: \(boundary)"
            )
        }
    }

    func testUploadFileSendsMultipartAndDecodesResponse() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/upload")
            XCTAssertEqual(request.httpMethod, "POST")

            let contentType = request.value(forHTTPHeaderField: "Content-Type")
            XCTAssertNotNil(contentType)
            XCTAssertTrue(contentType?.hasPrefix("multipart/form-data") == true)

            guard let body = apiTestBodyData(from: request) else {
                XCTFail("Missing request body")
                throw URLError(.badServerResponse)
            }

            let bodyString = String(data: body, encoding: .utf8) ?? ""
            XCTAssertTrue(bodyString.contains("Content-Disposition: form-data; name=\"session_id\""))
            XCTAssertTrue(bodyString.contains("abc123"))
            XCTAssertTrue(bodyString.contains("Content-Disposition: form-data; name=\"file\"; filename=\"test.jpg\""))
            XCTAssertTrue(bodyString.contains("hello"))

            return apiTestJSONResponse("""
            {
              "filename": "test.jpg",
              "path": "/tmp/workspace/test.jpg",
              "size": 5,
              "mime": "image/jpeg",
              "is_image": true
            }
            """, for: request)
        }

        let response = try await client.uploadFile(sessionID: "abc123", data: Data("hello".utf8), filename: "test.jpg")

        XCTAssertEqual(response.filename, "test.jpg")
        XCTAssertEqual(response.path, "/tmp/workspace/test.jpg")
        XCTAssertEqual(response.size, 5)
        XCTAssertEqual(response.mime, "image/jpeg")
        XCTAssertEqual(response.isImage, true)
    }
}
