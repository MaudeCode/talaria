import CoreGraphics
import XCTest
@testable import TalariaKit

final class RFBDecoderTests: XCTestCase {
    func testRecordedXvncHandshakeAndFramesDecodeAcrossSocketChunks() throws {
        // A public, synthetic desktop capture from Hermex v2.2.0, covered by the notice in RFBDecoder.swift.
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("TestFixtures/Screen/busy-tight.rfb")
        let recorded = try Data(contentsOf: fixture)
        let whole = try decode(recorded, chunkSize: recorded.count)
        let fragmented = try decode(recorded, chunkSize: 1_021)
        XCTAssertEqual(whole.responses, fragmented.responses)
        XCTAssertEqual(whole.pixels, fragmented.pixels)
        XCTAssertEqual(whole.updates, 2)
        XCTAssertEqual(fragmented.updates, 2)
        XCTAssertEqual(whole.responses.prefix(3), [Data("RFB 003.008\n".utf8), Data([1]), Data([1])])
        XCTAssertEqual(whole.responses.dropFirst(3).compactMap(\.first), [0, 2, 3])
        XCTAssertEqual(whole.responses.last, Data([3, 0, 0, 0, 0, 0, 5, 160, 3, 132]))
        let blue = Set(stride(from: 0, to: whole.pixels.count, by: 4).map { whole.pixels[$0] })
        XCTAssertGreaterThan(blue.count, 32, "The recorded desktop contains distinct colors")
    }

    private func decode(_ recording: Data, chunkSize: Int) throws -> (responses: [Data], updates: Int, pixels: Data) {
        let decoder = RFBDecoder()
        var responses: [Data] = []
        var updates = 0
        for offset in stride(from: 0, to: recording.count, by: chunkSize) {
            for output in try decoder.feed(recording[offset..<min(offset + chunkSize, recording.count)]) {
                switch output {
                case .send(let bytes): responses.append(bytes)
                case .updateComplete: updates += 1
                }
            }
        }
        let frame = try XCTUnwrap(decoder.snapshot())
        XCTAssertEqual(frame.width, 1_440)
        XCTAssertEqual(frame.height, 900)
        return (responses, updates, try XCTUnwrap(frame.dataProvider?.data) as Data)
    }
}
