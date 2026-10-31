import AVFoundation
import XCTest
@testable import TalariaKit

final class FeedbackVideoEncoderTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("FeedbackVideoEncoderTests-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testClipBecomesSilentMetadataFreeH264MP4WithinTheLimits() async throws {
        let directory = try temporaryDirectory()
        let source = directory.appendingPathComponent("source.mov")
        try await SyntheticClip.write(to: source, width: 1920, height: 1080, seconds: 2)
        let sourceAsset = AVURLAsset(url: source)
        let sourceAudio = try await sourceAsset.loadTracks(withMediaType: .audio)
        let sourceMetadata = try await sourceAsset.load(.metadata)
        XCTAssertEqual(sourceAudio.count, 1, "The synthetic source must carry audio to prove it is dropped")
        XCTAssertFalse(sourceMetadata.isEmpty, "The synthetic source must carry a location to prove it is dropped")

        let output = directory.appendingPathComponent("feedback.mp4")
        let maxBytes = 400_000
        try await FeedbackVideoEncoder.encode(source, to: output, maxBytes: maxBytes, maxSeconds: 120)

        let asset = AVURLAsset(url: output)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        let metadata = try await asset.load(.metadata)
        XCTAssertEqual(videoTracks.count, 1)
        XCTAssertTrue(audioTracks.isEmpty, "The re-encoded clip must have no audio track")
        XCTAssertTrue(metadata.isEmpty, "The re-encoded clip must carry no metadata, got \(metadata)")
        let track = try XCTUnwrap(videoTracks.first)
        let (size, formats) = try await track.load(.naturalSize, .formatDescriptions)
        XCTAssertEqual(size.width, 1280)
        XCTAssertEqual(size.height, 720)
        XCTAssertEqual(formats.first.map(CMFormatDescriptionGetMediaSubType), kCMVideoCodecType_H264)
        let data = try Data(contentsOf: output)
        XCTAssertLessThanOrEqual(data.count, maxBytes)
        XCTAssertEqual(String(decoding: data[4..<8], as: UTF8.self), "ftyp")
        XCTAssertTrue(["mp42", "isom", "mp41"].contains(String(decoding: data[8..<12], as: UTF8.self)), "The container must be MP4")
    }

    func testClipOverTheLengthLimitIsRefusedBeforeEncoding() async throws {
        let directory = try temporaryDirectory()
        let source = directory.appendingPathComponent("long.mov")
        try await SyntheticClip.write(to: source, width: 320, height: 240, seconds: 2)
        let output = directory.appendingPathComponent("feedback.mp4")
        do {
            try await FeedbackVideoEncoder.encode(source, to: output, maxBytes: 20_000_000, maxSeconds: 1)
            XCTFail("A clip longer than maxVideoSeconds must not be attached")
        } catch {
            XCTAssertEqual(error as? FeedbackVideoEncoder.Failure, .tooLong(maxSeconds: 1))
            XCTAssertEqual(error.localizedDescription, "Videos must be 1 seconds or shorter.")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }

    func testBitrateFitsTheLongestClipIntoTheByteLimit() {
        XCTAssertEqual(FeedbackVideoEncoder.bitrate(duration: 10, maxBytes: 20_000_000), 2_500_000)
        XCTAssertEqual(FeedbackVideoEncoder.bitrate(duration: 120, maxBytes: 20_000_000), 1_200_000)
    }
}

/// A synthetic camera clip: moving H.264 frames, a silent AAC track and a QuickTime location, all test-owned.
enum SyntheticClip {
    static func write(to url: URL, width: Int, height: Int, seconds: Int, fps: Int32 = 30) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let location = AVMutableMetadataItem()
        location.identifier = .quickTimeMetadataLocationISO6709
        location.value = "+37.3300-122.0300/" as NSString
        location.dataType = kCMMetadataBaseDataType_UTF8 as String
        writer.metadata = [location]
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height
        ])
        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1
        ])
        writer.add(video)
        writer.add(audio)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)

        try await waitUntilReady(audio)
        XCTAssertTrue(audio.append(try silence(seconds: seconds)))
        audio.markAsFinished()

        for frame in 0..<(Int(fps) * seconds) {
            try await waitUntilReady(video)
            let pool = try XCTUnwrap(adaptor.pixelBufferPool)
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            let pixels = try XCTUnwrap(buffer)
            draw(frame, into: pixels, width: width, height: height)
            XCTAssertTrue(adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps)))
        }
        video.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
    }

    private static func waitUntilReady(_ input: AVAssetWriterInput) async throws {
        for _ in 0..<1_000 where !input.isReadyForMoreMediaData {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(input.isReadyForMoreMediaData)
    }

    /// A moving bar over a gradient, so the encoder has real motion to compress.
    private static func draw(_ frame: Int, into buffer: CVPixelBuffer, width: Int, height: Int) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        context?.setFillColor(CGColor(red: 0.1, green: 0.3, blue: CGFloat(frame % 30) / 30, alpha: 1))
        context?.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context?.setFillColor(CGColor(red: 1, green: 0.8, blue: 0.2, alpha: 1))
        context?.fill(CGRect(x: (frame * 17) % width, y: 0, width: width / 10, height: height))
    }

    private static func silence(seconds: Int) throws -> CMSampleBuffer {
        let frames = 44_100 * seconds
        var description = AudioStreamBasicDescription(
            mSampleRate: 44_100, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                       magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: frames * 2, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: frames * 2,
                                           flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        let data = try XCTUnwrap(block)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: data, offsetIntoDestination: 0, dataLength: frames * 2)
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: data, formatDescription: try XCTUnwrap(format),
                                                             sampleCount: frames, presentationTimeStamp: .zero,
                                                             packetDescriptions: nil, sampleBufferOut: &sample)
        return try XCTUnwrap(sample)
    }
}
