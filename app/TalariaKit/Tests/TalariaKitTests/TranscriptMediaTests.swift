import XCTest
@testable import TalariaKit

/// TAL-186: the server owns media recognition; the App decodes its items, resolves their URLs and caches per session.
final class TranscriptMediaTests: XCTestCase {
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    func testMessageDecodesTheServerDisplayBodyAndDropsMalformedMediaItems() throws {
        let message = try decoder.decode(ChatMessage.self, from: Data(#"""
        {
          "role": "assistant",
          "content": "See MEDIA:/tmp/a.png and MEDIA:/tmp/b.mp3",
          "_display_content": "See ![a.png](./api/media?path=%2Ftmp%2Fa.png&session_id=s1) and [b.mp3](./api/media?path=%2Ftmp%2Fb.mp3&session_id=s1)",
          "_media": [
            {"url": "./api/media?path=%2Ftmp%2Fa.png&session_id=s1", "name": "a.png", "mime": "image/png", "kind": "image"},
            {"url": "", "name": "empty", "mime": "image/png", "kind": "image"},
            "not an item",
            {"url": "./api/media?path=%2Ftmp%2Fb.mp3&session_id=s1", "name": "b.mp3", "mime": "audio/mpeg", "kind": "audio"},
            {"url": "./api/media?path=%2Ftmp%2Fc.pdf&session_id=s1", "name": "c.pdf", "mime": "application/pdf", "kind": "pdf"}
          ]
        }
        """#.utf8))

        XCTAssertEqual(message.content, "See MEDIA:/tmp/a.png and MEDIA:/tmp/b.mp3")
        let display = try XCTUnwrap(message.displayBody)
        XCTAssertTrue(display.text.hasPrefix("See ![a.png](./api/media?"))
        XCTAssertEqual(display.media.map(\.name), ["a.png", "b.mp3", "c.pdf"])
        XCTAssertEqual(display.media.map(\.mediaKind), [.image, .audio, .unsupported])
        XCTAssertEqual(display.tiles.map(\.name), ["b.mp3", "c.pdf"])
        XCTAssertEqual(display.image(for: URL(string: "./api/media?path=%2Ftmp%2Fa.png&session_id=s1"))?.name, "a.png")
        XCTAssertNil(display.image(for: URL(string: "./api/media?path=%2Ftmp%2Fb.mp3&session_id=s1")), "Only image items load inline")
        XCTAssertNil(display.image(for: URL(string: "https://cdn.example.test/a.png")))
    }

    func testAMessageWithoutServerDisplayTextHasNoDisplayBody() throws {
        let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role": "assistant", "content": "MEDIA:/tmp/a.png"}"#.utf8))
        XCTAssertNil(message.displayBody)
    }

    func testServerMediaURLsResolveUnderTheBaseURLAndOnlyHTTPLoads() throws {
        for base in ["https://example.test/talaria", "https://example.test/talaria/"] {
            let client = APIClient(baseURL: try XCTUnwrap(URL(string: base)))
            XCTAssertEqual(
                client.transcriptMediaURL(for: "./api/media?path=%2Ftmp%2Fa%20b.png&session_id=s1")?.absoluteString,
                "https://example.test/talaria/api/media?path=%2Ftmp%2Fa%20b.png&session_id=s1",
                base
            )
            XCTAssertEqual(
                client.transcriptMediaURL(for: "/api/media?path=%2Ftmp%2Fa.png&session_id=s1")?.absoluteString,
                "https://example.test/talaria/api/media?path=%2Ftmp%2Fa.png&session_id=s1",
                base
            )
        }
        let client = APIClient(baseURL: try XCTUnwrap(URL(string: "https://example.test")))
        XCTAssertEqual(client.transcriptMediaURL(for: "https://cdn.example.test/a.png?x=1")?.absoluteString, "https://cdn.example.test/a.png?x=1")
        XCTAssertNil(client.transcriptMediaURL(for: "file:///tmp/a.png"))
        XCTAssertNil(client.transcriptMediaURL(for: "javascript:alert(1)"))
        XCTAssertNil(client.transcriptMediaURL(for: "./"))
    }

    /// A remote URL with no extension has no known kind (the server sends `file`); the App resolves it by its bytes.
    func testOnlyAnUnclassifiedRemoteItemIsResolvedFromItsBytes() {
        XCTAssertTrue(TranscriptMediaReference(url: "https://cdn.example.test/media/abc123", name: "abc123", mediaKind: .unsupported).isUnknownRemoteMedia)
        XCTAssertFalse(TranscriptMediaReference(url: "https://cdn.example.test/report.zip", name: "report.zip", mediaKind: .unsupported).isUnknownRemoteMedia)
        XCTAssertFalse(TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Fresults&session_id=s1", name: "results", mediaKind: .unsupported).isUnknownRemoteMedia)
        XCTAssertFalse(TranscriptMediaReference(url: "https://cdn.example.test/media/abc123", name: "abc123", mediaKind: .image).isUnknownRemoteMedia)
        let resolved = TranscriptMediaReference(url: "https://cdn.example.test/media/abc123", name: "abc123", mediaKind: .unsupported).resolved(as: .video)
        XCTAssertEqual(resolved.mediaKind, .video)
        XCTAssertEqual(resolved.url, "https://cdn.example.test/media/abc123")
    }

    func testMergedSceneProseRowsMergeTheirDisplayText() throws {
        let message = try decoder.decode(ChatMessage.self, from: Data(#"""
        {
          "role": "assistant",
          "content": "Done.",
          "_anchor_activity_scene": {
            "version": "activity_scene_v1",
            "final_answer": "Done.",
            "activity_rows": [
              {"row_id": "p1", "order_index": 0, "role": "prose", "text": "Plain. "},
              {"row_id": "p2", "order_index": 1, "role": "prose", "text": "MEDIA:/tmp/a.png", "display_text": "![a.png](./api/media?path=%2Ftmp%2Fa.png&session_id=s1)",
               "media": [{"url": "./api/media?path=%2Ftmp%2Fa.png&session_id=s1", "name": "a.png", "mime": "image/png", "kind": "image"}]},
              {"row_id": "t1", "order_index": 2, "role": "tool", "tool": {"id": "t1", "name": "read_file", "done": true, "is_error": false}}
            ]
          }
        }
        """#.utf8))

        let rows = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message)).rows
        let prose = try XCTUnwrap(rows.first)
        XCTAssertEqual(prose.text, "Plain. MEDIA:/tmp/a.png")
        XCTAssertEqual(prose.display?.text, "Plain. ![a.png](./api/media?path=%2Ftmp%2Fa.png&session_id=s1)")
        XCTAssertEqual(prose.display?.media.map(\.name), ["a.png"])
        XCTAssertNil(rows.last?.display, "The final answer had no media to rewrite")
    }

    func testImageCacheSeparatesSameResourceAcrossSessions() async {
        let firstSessionKey = DecodedImageCacheKey(
            namespace: "https://one.example.test|session-a",
            resourceID: "/tmp/result.png"
        )
        let secondSessionKey = DecodedImageCacheKey(
            namespace: "https://one.example.test|session-b",
            resourceID: "/tmp/result.png"
        )
        let secondServerKey = DecodedImageCacheKey(
            namespace: "https://two.example.test|session-a",
            resourceID: "/tmp/result.png"
        )

        XCTAssertNotEqual(firstSessionKey, secondSessionKey)
        XCTAssertNotEqual(firstSessionKey, secondServerKey)

        // Assert on loader calls, not on a cache hit: NSCache may evict any entry under memory pressure. A key
        // that collided with an earlier one would return that image without running its own loader.
        let cache = DecodedImageCache()
        let firstImage = PlatformImage()
        let secondImage = PlatformImage()
        let thirdImage = PlatformImage()
        let secondLoads = LockedCounter()
        let thirdLoads = LockedCounter()
        let loadedFirst = await cache.image(for: firstSessionKey) { firstImage }
        let loadedSecond = await cache.image(for: secondSessionKey) {
            _ = secondLoads.increment()
            return secondImage
        }
        let loadedThird = await cache.image(for: secondServerKey) {
            _ = thirdLoads.increment()
            return thirdImage
        }
        // Hit or reload, the first key must still resolve to its own image.
        let reloadedFirst = await cache.image(for: firstSessionKey) { firstImage }

        XCTAssertTrue(loadedFirst === firstImage)
        XCTAssertEqual(secondLoads.count, 1, "Another session must not reuse the first session's image")
        XCTAssertTrue(loadedSecond === secondImage)
        XCTAssertEqual(thirdLoads.count, 1, "Another server must not reuse the first server's image")
        XCTAssertTrue(loadedThird === thirdImage)
        XCTAssertTrue(reloadedFirst === firstImage)
    }
}
