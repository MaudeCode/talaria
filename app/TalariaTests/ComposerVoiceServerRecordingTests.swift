import AVFoundation
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Covers the Server First dictation recording format and the client upload
/// ceiling that keeps a long recording out of `Data(contentsOf:)` and off the wire.
final class ComposerVoiceServerRecordingTests: XCTestCase {
    func testServerRecordingSettingsAreMonoAACAtFixedBitrate() {
        let settings = ComposerVoiceInputController.serverRecordingSettings

        XCTAssertEqual(settings[AVFormatIDKey] as? Int, Int(kAudioFormatMPEG4AAC))
        XCTAssertEqual(settings[AVNumberOfChannelsKey] as? Int, 1)
        XCTAssertEqual(settings[AVSampleRateKey] as? Double, 16_000)
        XCTAssertEqual(settings[AVEncoderBitRateKey] as? Int, ComposerVoiceInputController.serverRecordingBitRate)
        // The old uncompressed settings must be gone, or the size math below lies.
        XCTAssertNil(settings[AVLinearPCMBitDepthKey])
    }

    func testServerRecordingURLKeepsM4AExtension() {
        let url = ComposerVoiceInputController.makeServerRecordingURL(
            uuid: UUID(uuidString: "ABCDEF01-2345-6789-ABCD-EF0123456789")!
        )

        XCTAssertEqual(url.pathExtension, "m4a")
        XCTAssertTrue(url.lastPathComponent.hasSuffix(".m4a"))
        XCTAssertTrue(url.lastPathComponent.hasPrefix("talaria-composer-stt-"))
    }

    func testUploadCeilingStaysUnderServerLimitAndFitsLongDictation() {
        let ceiling = ComposerVoiceInputController.maximumServerUploadBytes
        XCTAssertLessThan(ceiling, PendingAttachment.maximumUploadBytes)

        // Mono AAC at a fixed bitrate makes the size deterministic: bytes = rate/8 * s.
        // An hour of dictation is ~14 MB, so normal long recordings stay under the
        // ceiling and only an absurd (~87 minute) one trips the fallback.
        let bytesPerSecond = ComposerVoiceInputController.serverRecordingBitRate / 8
        XCTAssertLessThan(bytesPerSecond * 60 * 60, ceiling)
        XCTAssertGreaterThan(bytesPerSecond * 90 * 60, ceiling)
    }

    func testRecordedByteCountReadsFileMetadata() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("talaria-stt-size-\(UUID().uuidString).m4a")
        try Data(repeating: 7, count: 2_048).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        XCTAssertEqual(try ComposerVoiceInputController.recordedByteCount(at: url), 2_048)
    }

    func testRecordedByteCountThrowsForMissingFile() {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("talaria-stt-missing-\(UUID().uuidString).m4a")

        XCTAssertThrowsError(try ComposerVoiceInputController.recordedByteCount(at: missing))
    }

    func testOversizedAndUnreadableRecordingsHaveUserFacingMessages() {
        XCTAssertFalse(ComposerVoiceInputError.recordingTooLargeToUpload.localizedDescription.isEmpty)
        XCTAssertFalse(ComposerVoiceInputError.recordingUnreadable.localizedDescription.isEmpty)
    }
}
