import Foundation
import UniformTypeIdentifiers

public enum TranscriptMediaResolvedExportKind: Sendable {
    case image
    case audio
    case video
    case data
}

public enum TranscriptMediaExportSupport {
    public static func payload(
        for reference: TranscriptMediaReference,
        data: Data,
        resolvedKind: TranscriptMediaResolvedExportKind? = nil
    ) -> FileExportPayload {
        let descriptor = exportDescriptor(for: reference, data: data, resolvedKind: resolvedKind)
        return FileExportPayload(
            data: data,
            filename: exportFilename(for: reference, fileExtension: descriptor.fileExtension),
            contentType: descriptor.contentType,
            isImage: descriptor.kind == .image,
            isVideo: descriptor.kind == .video
        )
    }

    private static func exportDescriptor(
        for reference: TranscriptMediaReference,
        data: Data,
        resolvedKind: TranscriptMediaResolvedExportKind?
    ) -> TranscriptMediaExportDescriptor {
        if let fileExtension = reference.exportFileExtension,
           let contentType = UTType(filenameExtension: fileExtension) {
            return TranscriptMediaExportDescriptor(
                kind: exportKind(for: contentType),
                contentType: contentType,
                fileExtension: fileExtension
            )
        }

        if resolvedKind != .image, let audio = AttachmentAudioDetection.containerType(of: data) {
            return TranscriptMediaExportDescriptor(kind: .audio, contentType: audio.contentType, fileExtension: audio.fileExtension)
        }

        if resolvedKind == .image || decodesAsImage(data) {
            return TranscriptMediaExportDescriptor(kind: .image, contentType: .png, fileExtension: "png")
        }

        if resolvedKind == .audio {
            return TranscriptMediaExportDescriptor(kind: .audio, contentType: UTType(filenameExtension: "m4a") ?? .audio, fileExtension: "m4a")
        }

        if resolvedKind == .data {
            return TranscriptMediaExportDescriptor(kind: .data, contentType: .data, fileExtension: "bin")
        }

        return TranscriptMediaExportDescriptor(kind: .video, contentType: .mpeg4Movie, fileExtension: "mp4")
    }

    private static func exportFilename(for reference: TranscriptMediaReference, fileExtension: String) -> String {
        let baseName = reference.exportBaseName
        guard URL(fileURLWithPath: baseName).pathExtension.isEmpty else {
            return baseName
        }

        return "\(baseName).\(fileExtension)"
    }

    private static func exportKind(for contentType: UTType) -> TranscriptMediaResolvedExportKind {
        if contentType.conforms(to: .image) {
            return .image
        }

        if contentType.conforms(to: .audio) {
            return .audio
        }

        if contentType.conforms(to: .movie) || contentType.conforms(to: .video) {
            return .video
        }

        return .data
    }

    private static func decodesAsImage(_ data: Data) -> Bool {
#if DEBUG
        TranscriptMediaProbeRecorder.record("imageDecode")
#endif
        return PlatformImage(data: data) != nil
    }
}

private struct TranscriptMediaExportDescriptor {
    let kind: TranscriptMediaResolvedExportKind
    let contentType: UTType
    let fileExtension: String
}

extension TranscriptMediaReference {
    var exportBaseName: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(localized: "Hermes Media") : trimmed
    }

    var exportFileExtension: String? {
        fileExtension.isEmpty ? nil : fileExtension
    }
}
