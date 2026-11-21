import XCTest
@testable import TalariaKit

final class TranscriptLinkPreviewTests: XCTestCase {
    func testPreviewCacheReturnsStoredSnapshotForNormalizedURL() async throws {
        let cache = TranscriptLinkPreviewCache(maximumEntryCount: 4)
        let sourceURL = try XCTUnwrap(URL(string: "https://Example.com:443/path#section"))
        let lookupURL = try XCTUnwrap(URL(string: "https://example.com/path"))
        let snapshot = TranscriptLinkPreviewSnapshot(
            title: "Example",
            displayURL: sourceURL,
            imageData: Data([1, 2, 3])
        )

        await cache.store(snapshot, for: sourceURL)

        let cachedSnapshot = await cache.snapshot(for: lookupURL)
        XCTAssertEqual(cachedSnapshot, snapshot)
    }

    func testPreviewCacheEvictsLeastRecentlyUsedEntry() async throws {
        let cache = TranscriptLinkPreviewCache(maximumEntryCount: 2)
        let firstURL = try XCTUnwrap(URL(string: "https://first.example"))
        let secondURL = try XCTUnwrap(URL(string: "https://second.example"))
        let thirdURL = try XCTUnwrap(URL(string: "https://third.example"))

        await cache.store(TranscriptLinkPreviewSnapshot(title: "First"), for: firstURL)
        await cache.store(TranscriptLinkPreviewSnapshot(title: "Second"), for: secondURL)
        _ = await cache.snapshot(for: firstURL)
        await cache.store(TranscriptLinkPreviewSnapshot(title: "Third"), for: thirdURL)

        let firstSnapshot = await cache.snapshot(for: firstURL)
        let secondSnapshot = await cache.snapshot(for: secondURL)
        let thirdSnapshot = await cache.snapshot(for: thirdURL)

        XCTAssertNotNil(firstSnapshot)
        XCTAssertNil(secondSnapshot)
        XCTAssertNotNil(thirdSnapshot)
    }

    func testPreviewCacheIgnoresNonWebURLs() async throws {
        let cache = TranscriptLinkPreviewCache(maximumEntryCount: 4)
        let fileURL = try XCTUnwrap(URL(string: "file:///tmp/report.txt"))

        await cache.store(TranscriptLinkPreviewSnapshot(title: "File"), for: fileURL)

        let cachedSnapshot = await cache.snapshot(for: fileURL)

        XCTAssertNil(TranscriptLinkPreviewCache.cacheKey(for: fileURL))
        XCTAssertNil(cachedSnapshot)
    }
}
