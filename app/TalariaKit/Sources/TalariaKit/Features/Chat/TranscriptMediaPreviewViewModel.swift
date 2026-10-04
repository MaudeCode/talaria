import Foundation
import SwiftUI

@MainActor
@Observable
public final class TranscriptMediaPreviewViewModel {
    private let reference: TranscriptMediaReference
    private let apiClient: APIClient
    private var didLoad = false
    private var loadGeneration = 0
    private var originalData: Data?
    private var temporaryVideoURL: URL?

    public private(set) var previewData: Data?
    public private(set) var videoFileURL: URL?
    public private(set) var originalByteCount: Int?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var lastError: Error?

    public init(
        server: URL,
        reference: TranscriptMediaReference,
        apiClient: APIClient? = nil
    ) {
        self.reference = reference
        self.apiClient = apiClient ?? APIClient(baseURL: server)
    }

    var canSaveImageToPhotos: Bool {
        reference.isRasterImageCandidate && previewData != nil
    }

    var canSaveVideoToPhotos: Bool {
        videoFileURL != nil && originalData != nil
    }

    public var canSaveMediaToPhotos: Bool {
        canSaveImageToPhotos || canSaveVideoToPhotos
    }

    public var canExportMedia: Bool {
        originalData != nil
    }

    public func load(force: Bool = false) async {
        guard force || !didLoad else { return }
        loadGeneration += 1
        let generation = loadGeneration
        didLoad = true
        previewData = nil
        videoFileURL = nil
        originalByteCount = nil
        originalData = nil
        removeTemporaryVideoFile()

        guard reference.isRasterImageCandidate || reference.mediaKind == .video else {
            errorMessage = String(localized: "Preview is not available for this media type.")
            return
        }

        isLoading = true
        errorMessage = nil
        lastError = nil
        defer {
            if loadGeneration == generation {
                isLoading = false
            }
        }

        do {
            let data = try await apiClient.transcriptMediaData(for: reference)
            guard !Task.isCancelled, loadGeneration == generation else { return }
            originalData = data
            originalByteCount = data.count

            if reference.mediaKind == .video {
                let fileURL = try writeTemporaryVideoFile(data)
                guard !Task.isCancelled, loadGeneration == generation else {
                    try? FileManager.default.removeItem(at: fileURL)
                    return
                }
                temporaryVideoURL = fileURL
                videoFileURL = fileURL
            } else {
                if let downsampled = await ImagePreviewDownsampler.previewDataAsync(
                    from: data,
                    maxPixelSize: ImagePreviewDownsampler.filePreviewMaxPixelSize
                ) {
                    guard !Task.isCancelled, loadGeneration == generation else { return }
                    previewData = downsampled
                } else {
                    guard !Task.isCancelled, loadGeneration == generation else { return }
                    errorMessage = String(localized: "Could not decode this image.")
                }
            }
        } catch {
            guard !Task.isCancelled, loadGeneration == generation else { return }
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    func originalImageData() async throws -> Data {
        try await originalMediaData()
    }

    func originalMediaData() async throws -> Data {
        if let originalData {
            return originalData
        }

        let data = try await apiClient.transcriptMediaData(for: reference)
        try Task.checkCancellation()
        originalData = data
        originalByteCount = data.count
        return data
    }

    public func exportPayload() async throws -> FileExportPayload {
        let data = try await originalMediaData()
        return TranscriptMediaExportSupport.payload(
            for: reference,
            data: data,
            resolvedKind: resolvedExportKind
        )
    }

    public func cleanupTemporaryFiles() {
        loadGeneration += 1
        isLoading = false
        removeTemporaryVideoFile()
        videoFileURL = nil
    }

    private func writeTemporaryVideoFile(_ data: Data) throws -> URL {
        let ext = reference.videoFileExtension
        let filename = "transcript-media-\(UUID().uuidString).\(ext)"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try data.write(to: url, options: [.atomic])
        return url
    }

    private func removeTemporaryVideoFile() {
        if let temporaryVideoURL {
            try? FileManager.default.removeItem(at: temporaryVideoURL)
        }
        temporaryVideoURL = nil
    }

    private var resolvedExportKind: TranscriptMediaResolvedExportKind? {
        if previewData != nil {
            return .image
        }

        if videoFileURL != nil {
            return .video
        }

        return nil
    }
}

private extension TranscriptMediaReference {
    var videoFileExtension: String {
        fileExtension.isEmpty ? "mp4" : fileExtension
    }
}
