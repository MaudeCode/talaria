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

    public enum UploadFormat: Sendable {
        /// PNG when the source has an alpha channel, JPEG otherwise.
        case automatic
        case jpeg
        case png
    }

    /// A picked photo re-encoded for upload (TAL-865): orientation applied, the long edge capped at
    /// `maxPixelSize`, in `format`. Only the pixels are written, so EXIF, GPS and other source metadata never
    /// leave the device. The extension names the encoded type. Nil when the data does not decode as an image.
    /// Runs off the caller's actor.
    public static func uploadImage(
        from data: Data,
        maxPixelSize: Int = uploadMaxPixelSize,
        format: UploadFormat = .automatic,
        jpegQuality: Double = 0.85
    ) async -> (data: Data, fileExtension: String)? {
        await Task.detached(priority: .userInitiated) {
            guard let source = imageSource(data),
                  let image = thumbnail(of: source, maxPixelSize: maxPixelSize)
            else { return nil }
            let png: Bool
            switch format {
            case .png: png = true
            case .jpeg: png = false
            case .automatic:
                // The source's flag, not the decoded bitmap's: HEIC decodes into an alpha-carrying bitmap even when opaque.
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
                png = (properties?[kCGImagePropertyHasAlpha] as? Bool) ?? false
            }
            let encoded = png
                ? encode(image, as: "public.png", quality: nil)
                : encode(image, as: "public.jpeg", quality: jpegQuality)
            return encoded.map { (removingMetadata(from: $0), png ? "png" : "jpg") }
        }.value
    }

    /// Drops the metadata ImageIO writes on its own even for a bare bitmap (an EXIF block with the colour space and
    /// pixel size): JPEG APP1 segments, and PNG `eXIf`, text and time chunks. Pixels and any ICC profile stay.
    /// Returns the input unchanged when it is not a well-formed JPEG or PNG.
    static func removingMetadata(from data: Data) -> Data {
        let bytes = [UInt8](data)
        func bigEndian(_ index: Int, _ count: Int) -> Int? {
            guard index >= 0, index + count <= bytes.count else { return nil }
            return bytes[index..<index + count].reduce(0) { $0 << 8 | Int($1) }
        }
        var output: [UInt8] = []
        if bytes.starts(with: [0xFF, 0xD8]) {
            output = [0xFF, 0xD8]
            var index = 2
            while true {
                guard index + 1 < bytes.count, bytes[index] == 0xFF else { return data }
                let marker = bytes[index + 1]
                // Start of scan: the entropy-coded image data runs to the end.
                if marker == 0xDA { output += bytes[index...]; break }
                guard let length = bigEndian(index + 2, 2), length >= 2, index + 2 + length <= bytes.count else { return data }
                if marker != 0xE1 { output += bytes[index..<index + 2 + length] }
                index += 2 + length
            }
        } else if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            output = Array(bytes[0..<8])
            var index = 8
            while index < bytes.count {
                guard let length = bigEndian(index, 4), index + 12 + length <= bytes.count else { return data }
                let type = String(decoding: bytes[index + 4..<index + 8], as: UTF8.self)
                if !["eXIf", "tEXt", "zTXt", "iTXt", "tIME"].contains(type) { output += bytes[index..<index + 12 + length] }
                index += 12 + length
            }
        } else {
            return data
        }
        return Data(output)
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

    static func encode(_ image: CGImage, as type: String, quality: Double?) -> Data? {
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
