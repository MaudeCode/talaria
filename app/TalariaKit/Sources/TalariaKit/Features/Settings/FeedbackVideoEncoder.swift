import AVFoundation
import Foundation

/// On-device re-encoding of a feedback video (TAL-1597): H.264 in MP4, the long edge at most 1280 px, no audio
/// track and no metadata, at a bitrate that fits any clip up to the server's length limit into its size limit.
/// `AVAssetExportSession` presets are not used: their bitrates are too high to fit long clips.
public enum FeedbackVideoEncoder {
    public static let maxPixelSize = 1_280
    public static let maxBitrate = 2_500_000.0

    public enum Failure: LocalizedError, Equatable {
        case tooLong(maxSeconds: Int)
        case tooLarge
        case unreadable

        public var errorDescription: String? {
            switch self {
            case .tooLong(let seconds): String(localized: "Videos must be \(seconds) seconds or shorter.")
            case .tooLarge: String(localized: "This file is too large to attach.")
            case .unreadable: String(localized: "This file could not be attached.")
            }
        }
    }

    /// The average bitrate, in bits per second, that keeps a clip of `duration` seconds within 90% of `maxBytes`.
    public static func bitrate(duration: Double, maxBytes: Int) -> Int {
        Int(min(maxBitrate, 0.9 * Double(maxBytes) * 8 / max(duration, 1)))
    }

    /// Writes the re-encoded clip to `destination`, replacing any file there. Throws `tooLong` before encoding
    /// when the clip exceeds `maxSeconds`, and `tooLarge` (removing the output) if the result still exceeds `maxBytes`.
    public static func encode(_ source: URL, to destination: URL, maxBytes: Int, maxSeconds: Int) async throws {
        let asset = AVURLAsset(url: source)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else { throw Failure.unreadable }
        guard duration <= Double(maxSeconds) else { throw Failure.tooLong(maxSeconds: maxSeconds) }
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure.unreadable }
        let (naturalSize, transform) = try await track.load(.naturalSize, .preferredTransform)
        let longEdge = max(naturalSize.width, naturalSize.height)
        guard longEdge > 0 else { throw Failure.unreadable }
        let scale = min(1, Double(maxPixelSize) / longEdge)

        try? FileManager.default.removeItem(at: destination)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        let writer = try AVAssetWriter(outputURL: destination, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: even(naturalSize.width * scale),
            AVVideoHeightKey: even(naturalSize.height * scale),
            AVVideoScalingModeKey: AVVideoScalingModeResize,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate(duration: duration, maxBytes: maxBytes),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ]
        ])
        input.transform = transform
        input.expectsMediaDataInRealTime = false
        writer.add(input)

        guard reader.startReading() else { throw reader.error ?? Failure.unreadable }
        guard writer.startWriting() else { reader.cancelReading(); throw writer.error ?? Failure.unreadable }
        writer.startSession(atSourceTime: .zero)
        await Pump(reader: reader, output: output, input: input).run()
        if reader.status == .failed || writer.status == .failed {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: destination)
            throw writer.error ?? reader.error ?? Failure.unreadable
        }
        await writer.finishWriting()
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: destination)
            throw writer.error ?? Failure.unreadable
        }
        let bytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
        guard bytes <= maxBytes else {
            try? FileManager.default.removeItem(at: destination)
            throw Failure.tooLarge
        }
    }

    /// A JPEG of the clip's first frame, its long edge at most `maxPixelSize`, for the attachment thumbnail.
    public static func thumbnail(of video: URL, maxPixelSize: Int = ImagePreviewDownsampler.attachmentMaxPixelSize) async -> Data? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixelSize, height: maxPixelSize)
        guard let image = try? await generator.image(at: .zero).image else { return nil }
        return ImagePreviewDownsampler.encode(image, as: "public.jpeg", quality: 0.8)
    }

    private static func even(_ value: Double) -> Int {
        max(2, Int(value.rounded()) & ~1)
    }

    /// Moves every decoded frame into the writer on one serial queue; resumes once the input is finished.
    private struct Pump: @unchecked Sendable {
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        let input: AVAssetWriterInput

        func run() async {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                input.requestMediaDataWhenReady(on: DispatchQueue(label: "feedback.video.encode")) {
                    while input.isReadyForMoreMediaData {
                        guard reader.status == .reading, let sample = output.copyNextSampleBuffer() else {
                            input.markAsFinished()
                            continuation.resume()
                            return
                        }
                        guard input.append(sample) else {
                            reader.cancelReading()
                            input.markAsFinished()
                            continuation.resume()
                            return
                        }
                    }
                }
            }
        }
    }
}
