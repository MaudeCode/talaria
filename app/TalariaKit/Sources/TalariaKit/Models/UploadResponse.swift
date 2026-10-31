import Foundation
import ImageIO

public struct UploadResponse: Codable {
    let filename: String?
    public let path: String?
    public let size: Int?
    public let mime: String?
    public let isImage: Bool?
    public let error: String?
    /// The most attachments the server keeps on one message.
    public let maxAttachmentsPerMessage: Int?
}

public struct PendingAttachment: Identifiable, Equatable {
    public let id: UUID
    public let name: String
    public let path: String
    public let mime: String
    public let size: Int?
    public let isImage: Bool
    public internal(set) var thumbnailData: Data?
    /// File name of the durable app-owned draft copy in ChatDraftAttachmentStore.
    /// Fresh composer attachments always have one; standalone sends such as voice
    /// notes do not participate in draft persistence and leave it nil.
    public let draftFileName: String?
    public var uploadPhase: UploadPhase

    public enum UploadPhase: Equatable {
        case staged, uploading, ready, failed(String)
    }

    public var isReadyToSend: Bool { uploadPhase == .ready && !path.isEmpty }

    public init(
        id: UUID = UUID(),
        name: String,
        path: String,
        mime: String,
        size: Int? = nil,
        isImage: Bool,
        thumbnailData: Data? = nil,
        draftFileName: String? = nil,
        uploadPhase: UploadPhase = .ready
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.mime = mime
        self.size = size
        self.isImage = isImage
        self.thumbnailData = thumbnailData
        self.draftFileName = draftFileName
        self.uploadPhase = uploadPhase
    }
}

public enum ImagePreviewDownsampler {
    public static let attachmentMaxPixelSize = 512
    public static let filePreviewMaxPixelSize = 2_048
    public static let uploadMaxPixelSize = 4_096

    public static func previewData(from data: Data, maxPixelSize: Int) -> Data? {
        guard maxPixelSize > 0 else { return data }
        guard let source = imageSource(data) else { return nil }

        if let size = pixelSize(for: source),
           max(size.width, size.height) <= maxPixelSize {
            return data
        }

        guard let thumbnail = thumbnail(of: source, maxPixelSize: maxPixelSize) else { return nil }
        return encode(thumbnail, as: "public.jpeg", quality: 0.82)
    }

    public static func previewDataAsync(from data: Data, maxPixelSize: Int) async -> Data? {
        guard !Task.isCancelled else { return nil }

        return await withTaskGroup(of: Data?.self) { group in
            group.addTask(priority: .userInitiated) {
                guard !Task.isCancelled else { return nil }
                return previewData(from: data, maxPixelSize: maxPixelSize)
            }

            guard let generatedPreviewData = await group.next() else {
                return nil
            }
            group.cancelAll()
            guard !Task.isCancelled else { return nil }
            return generatedPreviewData
        }
    }

    /// A picked photo re-encoded for upload (TAL-865): orientation applied, the long edge capped at
    /// `uploadMaxPixelSize`, PNG when the image has an alpha channel and JPEG otherwise. The extension names the
    /// encoded type. Nil when the data does not decode as an image. Runs off the caller's actor.
    public static func uploadImage(from data: Data) async -> (data: Data, fileExtension: String)? {
        await Task.detached(priority: .userInitiated) {
            guard let source = imageSource(data),
                  let image = thumbnail(of: source, maxPixelSize: uploadMaxPixelSize)
            else { return nil }
            // The source's flag, not the decoded bitmap's: HEIC decodes into an alpha-carrying bitmap even when opaque.
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            let hasAlpha = (properties?[kCGImagePropertyHasAlpha] as? Bool) ?? false
            let encoded = hasAlpha
                ? encode(image, as: "public.png", quality: nil)
                : encode(image, as: "public.jpeg", quality: 0.85)
            return encoded.map { ($0, hasAlpha ? "png" : "jpg") }
        }.value
    }

    private static func imageSource(_ data: Data) -> CGImageSource? {
        CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
    }

    /// The image with its orientation applied, its long edge at most `maxPixelSize`; never upscaled.
    private static func thumbnail(of source: CGImageSource, maxPixelSize: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static func encode(_ image: CGImage, as type: String, quality: Double?) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type as CFString, 1, nil) else { return nil }
        let options = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    private static func pixelSize(for source: CGImageSource) -> (width: Int, height: Int)? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = intValue(properties[kCGImagePropertyPixelWidth]),
              let height = intValue(properties[kCGImagePropertyPixelHeight])
        else {
            return nil
        }

        return (width, height)
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber {
            return number.intValue
        }

        return value as? Int
    }
}

extension PendingAttachment {
    public static let maximumUploadBytes = 20 * 1_024 * 1_024
    static let maximumUploadSizeDescription = "20 MB"

    public static func uploadTooLargeMessage(filename: String) -> String {
        "\(filename) is too large. Attachments must be \(maximumUploadSizeDescription) or smaller."
    }

    public func toJSONValue() -> JSONValue {
        var object: [String: JSONValue] = [
            "name": .string(name),
            "path": .string(path),
            "mime": .string(mime)
        ]
        if let size {
            object["size"] = .number(Double(size))
        }
        object["is_image"] = .bool(isImage)
        return .object(object)
    }
}
