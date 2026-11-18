import XCTest
@testable import TalariaKit

final class APIClientTTSTests: APIClientTestCase {
    func testSynthesizeSpeechPostsJSONAndReturnsRawAudioBytes() async throws {
        // Not valid MPEG audio — the client must return the bytes untouched,
        // never attempt to JSON-decode a 2xx TTS response.
        let audioBytes = Data([0xFF, 0xF3, 0x18, 0xC4, 0x00, 0x01])
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/tts")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

            guard let body = apiTestBodyData(from: request) else {
                XCTFail("Missing request body")
                throw URLError(.badServerResponse)
            }
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["text"] as? String, "Hello from Talaria.")
            // The server defaults to `zh-CN-XiaoxiaoNeural`, so the voice must
            // always be sent explicitly.
            XCTAssertEqual(json["voice"] as? String, "en-US-AriaNeural")
            // No engine/rate/pitch: the server defaults to the keyless edge engine
            // with neutral prosody, and a picker is a non-goal (#15).
            XCTAssertEqual(json.count, 2)

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, audioBytes)
        }

        let data = try await client.synthesizeSpeech(text: "Hello from Talaria.", voice: "en-US-AriaNeural")

        XCTAssertEqual(data, audioBytes)
    }
}
