import Foundation
import UIKit
import UniformTypeIdentifiers
import TalariaKit

@MainActor
@Observable
final class FilePreviewViewModel {
    private let session: SessionSummary
    private var path: String
    private let apiClient: APIClient
    private let imagePreparer: (Data, Int) async -> ImageFilePreview?
    private var loadGeneration = 0

    private(set) var preview: FilePreviewContent?
    private(set) var isLoading = false
    private(set) var isExporting = false
    private(set) var errorMessage: String?
    private(set) var exportErrorMessage: String?
    private(set) var lastError: Error?
    private var exportData: Data?

    init(
        session: SessionSummary,
        server: URL,
        path: String,
        apiClient: APIClient? = nil,
        imagePreparer: @escaping (Data, Int) async -> ImageFilePreview? = ImageFilePreview.prepare
    ) {
        self.session = session
        self.path = path
        self.apiClient = apiClient ?? APIClient(baseURL: server)
        self.imagePreparer = imagePreparer
    }

    var canExportFile: Bool {
        session.sessionId?.isEmpty == false && !path.isEmpty
    }

    var canSaveImageToPhotos: Bool {
        canExportFile && isRasterImagePath
    }

    func load(path requestedPath: String? = nil) async {
        if let requestedPath, requestedPath != path {
            path = requestedPath
            preview = nil
            exportData = nil
        }
        loadGeneration += 1
        let generation = loadGeneration
        let loadingPath = path

        guard let sessionID = session.sessionId else {
            errorMessage = String(localized: "Session ID is missing.")
            return
        }

        guard !path.isEmpty else {
            errorMessage = String(localized: "File path is missing.")
            return
        }

        isLoading = true
        errorMessage = nil
        exportErrorMessage = nil
        lastError = nil
        defer {
            if loadGeneration == generation {
                isLoading = false
            }
        }

        do {
            if isRasterImagePath {
                let data = try await apiClient.rawFileData(sessionID: sessionID, path: loadingPath)
                guard !Task.isCancelled, loadGeneration == generation, path == loadingPath else { return }
                exportData = data
                if let preparedImage = await imagePreparer(data, data.count) {
                    guard !Task.isCancelled, loadGeneration == generation, path == loadingPath else { return }
                    preview = .image(preparedImage)
                } else {
                    guard !Task.isCancelled, loadGeneration == generation, path == loadingPath else { return }
                    preview = .unavailable(String(localized: "Could not decode this image."))
                }
            } else if isKnownUnsupportedBinaryPath {
                preview = .unavailable(String(localized: "Preview is not available for this file type."))
            } else {
                let file = try await apiClient.file(sessionID: sessionID, path: loadingPath)
                guard !Task.isCancelled, loadGeneration == generation, path == loadingPath else { return }
                exportData = Data((file.content ?? "").utf8)
                preview = .text(file)
            }
        } catch {
            guard !Task.isCancelled, loadGeneration == generation, path == loadingPath else { return }
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    func exportPayload() async throws -> FileExportPayload {
        guard let sessionID = session.sessionId else {
            throw FileExportError.missingSessionID
        }

        guard !path.isEmpty else {
            throw FileExportError.missingPath
        }
        let exportPath = path
        let generation = loadGeneration

        if let exportData {
            return payload(with: exportData, path: exportPath)
        }

        isExporting = true
        exportErrorMessage = nil
        lastError = nil
        defer {
            isExporting = false
        }

        do {
            let data = try await apiClient.rawFileData(sessionID: sessionID, path: exportPath)
            guard !Task.isCancelled, loadGeneration == generation, path == exportPath else {
                throw FileExportError.selectionChanged
            }
            exportData = data
            return payload(with: data, path: exportPath)
        } catch {
            guard loadGeneration == generation, path == exportPath else {
                throw FileExportError.selectionChanged
            }
            lastError = error
            exportErrorMessage = error.localizedDescription
            throw error
        }
    }

    private var pathExtension: String {
        URL(fileURLWithPath: path).pathExtension.lowercased()
    }

    private var isRasterImagePath: Bool {
        Self.rasterImageExtensions.contains(pathExtension)
    }

    private var isKnownUnsupportedBinaryPath: Bool {
        [
            "7z", "a", "aiff", "avi", "bin", "bz2", "class", "db", "dmg", "doc",
            "docx", "dylib", "exe", "flac", "gz", "jar", "m4a", "mov", "mp3",
            "mp4", "o", "pdf", "pkg", "ppt", "pptx", "pyc", "rar", "sqlite",
            "svg", "tar", "tgz", "wav", "xls", "xlsx", "xz", "zip"
        ].contains(pathExtension)
    }

    private func payload(with data: Data, path: String) -> FileExportPayload {
        let pathExtension = pathExtension(for: path)
        return FileExportPayload(
            data: data,
            filename: exportFilename(for: path),
            contentType: UTType(filenameExtension: pathExtension) ?? .data,
            isImage: Self.rasterImageExtensions.contains(pathExtension),
            isVideo: Self.videoExtensions.contains(pathExtension)
        )
    }

    private func pathExtension(for path: String) -> String {
        URL(fileURLWithPath: path).pathExtension.lowercased()
    }

    private func exportFilename(for path: String) -> String {
        let lastPathComponent = URL(fileURLWithPath: path).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        return lastPathComponent.isEmpty ? String(localized: "Hermes File") : lastPathComponent
    }

    private static let rasterImageExtensions = Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"])
    private static let videoExtensions = Set(["m4v", "mov", "mp4"])
}

enum FilePreviewContent {
    case text(FileResponse)
    case image(ImageFilePreview)
    case audio(Data)
    case unavailable(String)
}

struct ImageFilePreview: @unchecked Sendable {
    let data: Data
    let preparedImage: UIImage?
    let originalByteCount: Int

    init(data: Data, preparedImage: UIImage? = nil, originalByteCount: Int) {
        self.data = data
        self.preparedImage = preparedImage
        self.originalByteCount = originalByteCount
    }

    nonisolated static func prepare(data: Data, originalByteCount: Int) async -> ImageFilePreview? {
        let task = Task.detached(priority: .userInitiated) { () -> ImageFilePreview? in
            guard !Task.isCancelled,
                  let previewData = ImagePreviewDownsampler.previewData(
                      from: data,
                      maxPixelSize: ImagePreviewDownsampler.filePreviewMaxPixelSize
                  ),
                  !Task.isCancelled,
                  let image = UIImage(data: previewData)
            else { return nil }

            return ImageFilePreview(
                data: previewData,
                preparedImage: image,
                originalByteCount: originalByteCount
            )
        }

        return await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }
}

struct FileExportPayload {
    let data: Data
    let filename: String
    let contentType: UTType
    let isImage: Bool
    let isVideo: Bool
}

enum FileExportError: LocalizedError, Equatable {
    case missingSessionID
    case missingPath
    case selectionChanged

    var errorDescription: String? {
        switch self {
        case .missingSessionID:
            String(localized: "Session ID is missing.")
        case .missingPath:
            String(localized: "File path is missing.")
        case .selectionChanged:
            String(localized: "The selected file changed before export finished.")
        }
    }
}
