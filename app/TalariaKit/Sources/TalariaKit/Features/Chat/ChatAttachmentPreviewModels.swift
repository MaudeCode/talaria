import Foundation
import SwiftUI

public struct ChatAttachmentPreviewItem: Identifiable, Equatable {
    public let id = UUID()
    public let name: String?
    public let path: String?
    public let mime: String?
    public let size: Int?
    let isImage: Bool?
    let localImageData: Data?

    public init(message attachment: MessageAttachment, localData: Data?) {
        name = attachment.name
        path = attachment.path
        mime = attachment.mime
        size = attachment.size
        isImage = attachment.isImage
        localImageData = localData
    }

    public init(pending attachment: PendingAttachment) {
        name = attachment.name
        path = attachment.path
        mime = attachment.mime
        size = attachment.size
        isImage = attachment.isImage
        localImageData = attachment.thumbnailData
    }

    public var displayName: String {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }

        if let path = path?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty {
            let lastPathComponent = URL(fileURLWithPath: path).lastPathComponent
            return lastPathComponent.isEmpty ? path : lastPathComponent
        }

        return inferredIsImage ? String(localized: "Image") : String(localized: "File")
    }

    public var displayPath: String {
        let trimmedPath = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmedPath, !trimmedPath.isEmpty else {
            return displayName
        }
        return trimmedPath
    }

    public var inferredIsImage: Bool {
        if isImage == true { return true }
        if let mime = mime?.lowercased(), mime.hasPrefix("image/") { return true }
        return Self.imageExtensions.contains(pathExtension)
    }

    var inferredIsAudio: Bool {
        AttachmentAudioDetection.isAudio(isImage: isImage, mime: mime, name: name, path: path)
    }

    var isKnownUnsupportedBinary: Bool {
        Self.unsupportedBinaryExtensions.contains(pathExtension)
    }

    private var pathExtension: String {
        URL(fileURLWithPath: name ?? path ?? "").pathExtension.lowercased()
    }

    private static let imageExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif", "ico"
    ]

    private static let unsupportedBinaryExtensions: Set<String> = [
        "7z", "a", "aiff", "avi", "bin", "bz2", "class", "db", "dmg", "doc",
        "docx", "dylib", "exe", "flac", "gz", "jar", "m4a", "mov", "mp3",
        "mp4", "o", "pdf", "pkg", "ppt", "pptx", "pyc", "rar", "sqlite",
        "svg", "tar", "tgz", "wav", "xls", "xlsx", "xz", "zip"
    ]
}

@MainActor
@Observable
public final class ChatAttachmentPreviewViewModel {
    private let session: SessionSummary
    private let item: ChatAttachmentPreviewItem
    private let apiClient: APIClient
    private var didLoad = false

    public private(set) var preview: FilePreviewContent?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var lastError: Error?

    public init(
        session: SessionSummary,
        server: URL,
        item: ChatAttachmentPreviewItem,
        apiClient: APIClient? = nil
    ) {
        self.session = session
        self.item = item
        self.apiClient = apiClient ?? APIClient(baseURL: server)
    }

    public func load(force: Bool = false) async {
        guard force || !didLoad else { return }
        didLoad = true
        preview = nil

        guard let sessionID = session.sessionId else {
            errorMessage = String(localized: "Session ID is missing.")
            return
        }

        let trimmedPath = item.path?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let path = trimmedPath, !path.isEmpty else {
            preview = localFallbackPreview
            return
        }

        isLoading = true
        errorMessage = nil
        lastError = nil
        defer { isLoading = false }

        do {
            if item.inferredIsImage {
                let data = try await apiClient.rawFileData(sessionID: sessionID, path: path)
                if let previewData = ImagePreviewDownsampler.previewData(
                    from: data,
                    maxPixelSize: ImagePreviewDownsampler.filePreviewMaxPixelSize
                ) {
                    preview = .image(.init(data: previewData, originalByteCount: data.count))
                } else {
                    preview = .unavailable(String(localized: "Could not decode this image."))
                }
            } else if item.inferredIsAudio {
                // Raw bytes (no downsampling) so AVAudioPlayer gets the original
                // encoded audio; checked before the unsupported-binary list,
                // which would otherwise reject m4a/mp3/wav/flac.
                preview = .audio(try await apiClient.rawFileData(sessionID: sessionID, path: path))
            } else if item.isKnownUnsupportedBinary {
                preview = .unavailable(String(localized: "Preview is not available for this file type."))
            } else {
                preview = .text(try await apiClient.file(sessionID: sessionID, path: path))
            }
        } catch {
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    private var localFallbackPreview: FilePreviewContent {
        if item.inferredIsImage, let data = item.localImageData {
            return .image(.init(data: data, originalByteCount: data.count))
        }

        return .unavailable(String(localized: "This attachment does not have a server file path."))
    }
}
