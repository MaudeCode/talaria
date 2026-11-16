import XCTest
@testable import TalariaKit

final class AttachmentAudioDetectionTests: XCTestCase {

    // MARK: - MIME detection

    func testMimeAudioPrefixIsAudio() {
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: nil, mime: "audio/mpeg", name: nil, path: nil))
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: nil, mime: "AUDIO/WEBM", name: "voice", path: nil))
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: false, mime: "audio/mp4", name: "clip.bin", path: nil))
    }

    func testNonAudioMimeIsNotAudio() {
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: "image/png", name: "pic.png", path: nil))
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: "text/plain", name: "notes.txt", path: nil))
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: "application/pdf", name: "doc.pdf", path: nil))
    }

    // MARK: - Extension detection

    func testKnownAudioExtensionsAreAudio() {
        for ext in ["m4a", "mp3", "wav", "aac", "caf", "ogg", "oga", "opus", "flac"] {
            XCTAssertTrue(
                AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "clip.\(ext)", path: nil),
                "Expected .\(ext) to be detected as audio"
            )
        }
    }

    func testExtensionDetectionIsCaseInsensitive() {
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "VOICE.M4A", path: nil))
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "Song.Mp3", path: nil))
    }

    func testExtensionDetectionWorksOnFullPaths() {
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "/workspace/voice/note.m4a", path: nil))
    }

    func testUnknownExtensionIsNotAudio() {
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "archive.zip", path: nil))
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "image.png", path: nil))
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "noextension", path: nil))
    }

    /// A human display name carries no extension, but the path does — detection
    /// should fall back to the path instead of giving up on the name alone.
    func testDisplayNameWithoutExtensionFallsBackToPath() {
        XCTAssertTrue(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "Voice note", path: "/ws/clip.m4a"))
        XCTAssertTrue(MessageAttachment(name: "Voice note", path: "/ws/clip.m4a").inferredIsAudio)
        // But a non-audio path is still not audio.
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "Voice note", path: "/ws/clip.pdf"))
    }

    // MARK: - isImage precedence

    func testExplicitImageFlagWinsOverAudioSignals() {
        // Contradictory inputs: the explicit server image flag always wins.
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: true, mime: "audio/mpeg", name: "weird.mp3", path: nil))
    }

    func testNilAndEmptyInputsAreNotAudio() {
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: nil, path: nil))
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: nil, name: "", path: ""))
        XCTAssertFalse(AttachmentAudioDetection.isAudio(isImage: nil, mime: "", name: "", path: ""))
    }

    // MARK: - MessageAttachment convenience

    func testMessageAttachmentInferredIsAudio() {
        XCTAssertTrue(MessageAttachment(name: "note.m4a").inferredIsAudio)
        XCTAssertTrue(MessageAttachment(name: nil, path: "/ws/voice.mp3").inferredIsAudio)
        XCTAssertTrue(MessageAttachment(name: "blob", mime: "audio/ogg").inferredIsAudio)
        XCTAssertFalse(MessageAttachment(name: "photo.png", isImage: true).inferredIsAudio)
        XCTAssertFalse(MessageAttachment(name: "data.json").inferredIsAudio)
    }

    // MARK: - Duration formatting

    func testDurationFormatting() {
        XCTAssertEqual(AudioDurationFormatter.string(from: 0), "0:00")
        XCTAssertEqual(AudioDurationFormatter.string(from: 5), "0:05")
        XCTAssertEqual(AudioDurationFormatter.string(from: 65), "1:05")
        XCTAssertEqual(AudioDurationFormatter.string(from: 600), "10:00")
        XCTAssertEqual(AudioDurationFormatter.string(from: 3661), "1:01:01")
    }

    func testDurationFormattingClampsInvalidInput() {
        XCTAssertEqual(AudioDurationFormatter.string(from: -5), "0:00")
        XCTAssertEqual(AudioDurationFormatter.string(from: .nan), "0:00")
        XCTAssertEqual(AudioDurationFormatter.string(from: .infinity), "0:00")
    }

    // MARK: - Inline player load state

    /// When the row scrolls off-screen mid-load the `.task` is cancelled and the
    /// loader returns nil; the player must reset to `.idle` (retryable) rather
    /// than getting stuck on the `.failed` error state.
    @MainActor
    func testCancelledLoadResetsToIdleForRetry() async {
        let model = InlineAudioPlayerModel()
        let task = Task { @MainActor in
            await model.loadIfNeeded(using: {
                await Task.yield()
                return nil
            })
        }
        task.cancel()
        await task.value
        XCTAssertEqual(model.phase, .idle)
    }

    /// A genuine load failure (not cancellation) still surfaces the error state.
    @MainActor
    func testGenuineLoadFailureShowsFailedState() async {
        let model = InlineAudioPlayerModel()
        await model.loadIfNeeded(using: { nil })
        XCTAssertEqual(model.phase, .failed)
    }

    // MARK: - Container header detection

    func testContainerTypeRecognizesEachAudioHeader() {
        let headers: [(bytes: [UInt8], fileExtension: String)] = [
            (Array(TestAudio.wavData(seconds: 0.01)), "wav"),
            (Array("ID3".utf8) + [0x04, 0x00], "mp3"),
            ([0xFF, 0xFB, 0x90, 0x64], "mp3"),
            (Array("caff".utf8) + [0x00, 0x01], "caf"),
            ([0x00, 0x00, 0x00, 0x20] + Array("ftypM4A ".utf8), "m4a"),
            (Array("fLaC".utf8) + [0x00, 0x00, 0x00, 0x22], "flac"),
            (Array("OggS".utf8) + [0x00, 0x02], "ogg"),
            (Array("FORM".utf8) + [0x00, 0x00, 0x10, 0x00] + Array("AIFF".utf8), "aiff")
        ]
        for header in headers {
            let type = AttachmentAudioDetection.containerType(of: Data(header.bytes))
            XCTAssertEqual(type?.fileExtension, header.fileExtension)
            XCTAssertEqual(type?.contentType.conforms(to: .audio), true, header.fileExtension)
        }
    }

    func testContainerTypeTellsAudioOnlyMPEG4FromMoviesUnderGenericBrands() {
        func box(_ type: String, _ payload: [UInt8]) -> [UInt8] {
            withUnsafeBytes(of: UInt32(8 + payload.count).bigEndian, Array.init) + Array(type.utf8) + payload
        }
        func mpeg4(brand: String, handlers: [String]) -> Data {
            let tracks = handlers.map { handler in
                box("trak", box("mdia", box("hdlr", [UInt8](repeating: 0, count: 8) + Array(handler.utf8) + [UInt8](repeating: 0, count: 13))))
            }
            return Data(box("ftyp", Array("\(brand)\0\0\u{2}\0isom".utf8)) + box("moov", tracks.flatMap { $0 }))
        }

        for brand in ["isom", "mp42"] {
            XCTAssertEqual(AttachmentAudioDetection.containerType(of: mpeg4(brand: brand, handlers: ["soun"]))?.fileExtension, "m4a", brand)
            XCTAssertNil(AttachmentAudioDetection.containerType(of: mpeg4(brand: brand, handlers: ["vide", "soun"])), brand)
        }
    }

    func testContainerTypeIgnoresImagesAndOtherBytes() throws {
        let png = try XCTUnwrap(TestImages.pngData(width: 2, height: 2))
        XCTAssertNil(AttachmentAudioDetection.containerType(of: png))
        XCTAssertNil(AttachmentAudioDetection.containerType(of: Data([0x5A, 0x13, 0xC7, 0x02, 0x9E, 0x41, 0x7B, 0x88, 0x0D, 0x66, 0xF3, 0x21])))
        XCTAssertNil(AttachmentAudioDetection.containerType(of: Data()))
    }
}
