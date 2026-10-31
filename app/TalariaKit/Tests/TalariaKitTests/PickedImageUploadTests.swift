import CoreGraphics
import Foundation
import ImageIO
import TalariaKit
import UniformTypeIdentifiers
import XCTest

/// A photo picked from Photos is re-encoded before upload, and its file name carries the encoded type (TAL-865).
final class PickedImageUploadTests: XCTestCase {
    func testHEICPickIsReencodedAsJPEG() async throws {
        let heic = try XCTUnwrap(TestImages.heicData(width: 64, height: 48))

        let encoded = await ImagePreviewDownsampler.uploadImage(from: heic)
        let upload = try XCTUnwrap(encoded)

        XCTAssertEqual(upload.fileExtension, "jpg")
        XCTAssertEqual(try imageType(of: upload.data), UTType.jpeg.identifier)
    }

    func testTranslucentPNGStaysPNGWithAlpha() async throws {
        let png = try XCTUnwrap(TestImages.translucentPNGData(width: 32, height: 32))

        let encoded = await ImagePreviewDownsampler.uploadImage(from: png)
        let upload = try XCTUnwrap(encoded)

        XCTAssertEqual(upload.fileExtension, "png")
        XCTAssertEqual(try imageType(of: upload.data), UTType.png.identifier)
        let image = try decodedImage(upload.data)
        XCTAssertFalse([.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo))
    }

    func testLargePickIsCappedAtTheUploadLongEdge() async throws {
        let jpeg = try XCTUnwrap(TestImages.jpegData(width: 6_000, height: 4_000))

        let encoded = await ImagePreviewDownsampler.uploadImage(from: jpeg)
        let upload = try XCTUnwrap(encoded)

        let image = try decodedImage(upload.data)
        XCTAssertEqual(max(image.width, image.height), 4_096)
        XCTAssertEqual(image.width, 4_096)
    }

    func testOrientationIsApplied() async throws {
        // EXIF orientation 6 displays the stored 64×48 pixels rotated to 48×64.
        let heic = try XCTUnwrap(TestImages.heicData(width: 64, height: 48, orientation: 6))

        let encoded = await ImagePreviewDownsampler.uploadImage(from: heic)
        let upload = try XCTUnwrap(encoded)

        let image = try decodedImage(upload.data)
        XCTAssertEqual(image.width, 48)
        XCTAssertEqual(image.height, 64)
    }

    func testUndecodablePayloadReturnsNil() async {
        let upload = await ImagePreviewDownsampler.uploadImage(from: Data("not an image".utf8))

        XCTAssertNil(upload)
    }

    private func imageType(of data: Data) throws -> String? {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return CGImageSourceGetType(source) as String?
    }

    private func decodedImage(_ data: Data) throws -> CGImage {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    }
}
