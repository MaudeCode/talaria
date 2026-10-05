import Foundation
import ImageIO

public struct UploadResponse: Codable {
    let filename: String?
    public let path: String?
    public let size: Int?
    public let mime: String?
    public let isImage: Bool?
    public let error: String?
    /// The server names this file in the turn's prompt itself (TAL-276), so the message carries
    /// only the draft. Absent from servers before TAL-635.
    public let namedInPrompt: Bool?
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
    public let thumbnailData: Data?
    /// File name of the durable app-owned draft copy in ChatDraftAttachmentStore.
    /// Fresh composer attachments always have one; standalone sends such as voice
    /// notes do not participate in draft persistence and leave it nil.
    public let draftFileName: String?
    /// The server that stored it names it in the prompt (TAL-635).
    public let isNamedInPromptByServer: Bool

    public init(
        id: UUID = UUID(),
        name: String,
        path: String,
        mime: String,
        size: Int? = nil,
        isImage: Bool,
        thumbnailData: Data? = nil,
        draftFileName: String? = nil,
        isNamedInPromptByServer: Bool = false
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.mime = mime
        self.size = size
        self.isImage = isImage
        self.thumbnailData = thumbnailData
        self.draftFileName = draftFileName
        self.isNamedInPromptByServer = isNamedInPromptByServer
    }
}

public enum ImagePreviewDownsampler {
    public static let attachmentMaxPixelSize = 512
    public static let filePreviewMaxPixelSize = 2_048

    public static func previewData(from data: Data, maxPixelSize: Int) -> Data? {
        guard maxPixelSize > 0 else { return data }

        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else {
            return nil
        }

        if let size = pixelSize(for: source),
           max(size.width, size.height) <= maxPixelSize {
            return data
        }

        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]

        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
            return nil
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            "public.jpeg" as CFString,
            1,
            nil
        ) else {
            return nil
        }

        let destinationOptions: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.82
        ]
        CGImageDestinationAddImage(destination, thumbnail, destinationOptions as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }

        return output as Data
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

    /// The chat `message` for a draft and its attachments. A server that names attached files in
    /// the prompt itself (TAL-276) gets the bare draft, as Web sends it; one that does not, which
    /// predates TAL-635 and never says so, still needs the files named in the text.
    public static func chatMessageText(draft: String, attachments: [PendingAttachment]) -> String {
        guard !attachments.allSatisfy(\.isNamedInPromptByServer) else { return draft }

        let references = attachments
            .map { $0.path.isEmpty ? $0.name : $0.path }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !references.isEmpty else {
            return draft
        }

        // Old-server fallback: a textless send has nothing to append the marker to, so the
        // WebUI synthesized the whole message. `MessageAttachment` parses this shape back out
        // for display; share its constants so the two cannot drift. Delete this branch once
        // every supported server sends `named_in_prompt`.
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return MessageAttachment.uploadedFilesPrefix
                + "\(references.count)"
                + MessageAttachment.uploadedFilesInfix
                + references.joined(separator: ", ")
        }

        return "\(draft)\n\n[Attached files: \(references.joined(separator: ", "))]"
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
