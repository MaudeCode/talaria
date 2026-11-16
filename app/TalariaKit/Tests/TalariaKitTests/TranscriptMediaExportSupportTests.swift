import UniformTypeIdentifiers
import XCTest
@testable import TalariaKit

/// Exporting remote media the server could not type: its kind and extension come from its bytes (TAL-866).
final class TranscriptMediaExportSupportTests: XCTestCase {
    private let reference = TranscriptMediaReference(url: "https://media.example.test/clip", name: "clip", mediaKind: .unsupported)

    func testExtensionlessWAVExportsAsWAVAudio() {
        let payload = TranscriptMediaExportSupport.payload(for: reference, data: TestAudio.wavData(seconds: 0.1))

        XCTAssertEqual(payload.filename, "clip.wav")
        XCTAssertEqual(payload.contentType, .wav)
        XCTAssertFalse(payload.isImage)
        XCTAssertFalse(payload.isVideo)
    }

    func testExtensionlessPNGStillExportsAsImage() throws {
        let png = try XCTUnwrap(TestImages.pngData(width: 4, height: 4))
        let payload = TranscriptMediaExportSupport.payload(for: reference, data: png)

        XCTAssertEqual(payload.filename, "clip.png")
        XCTAssertTrue(payload.isImage)
    }
}
