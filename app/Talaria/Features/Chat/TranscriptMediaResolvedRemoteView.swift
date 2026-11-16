import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

/// A remote item the server could not classify (`isUnknownRemoteMedia`), shown as whatever its bytes decode to.
struct TranscriptMediaResolvedRemoteView: View {
    let reference: TranscriptMediaReference
    let loadMediaData: @MainActor (TranscriptMediaReference) async -> Data?
    let onPreviewMedia: (@MainActor (TranscriptMediaReference) -> Void)?

    @State private var resolvedMedia: ResolvedMedia?

    var body: some View {
        Group {
            switch resolvedMedia {
            case let .image(image):
                Button {
                    onPreviewMedia?(reference.resolved(as: .image))
                } label: {
                    thumbnailContent(image)
                }
                .buttonStyle(.chatTactile(.thumbnail))
                .accessibilityLabel(String(localized: "Open media image \(reference.displayName)"))

            case let .audio(data):
                TranscriptMediaAudioExportView(
                    reference: reference,
                    initialData: data,
                    loadMediaData: { data }
                )

            case .video:
                Button {
                    onPreviewMedia?(reference.resolved(as: .video))
                } label: {
                    TranscriptMediaVideoTile(reference: reference)
                }
                .buttonStyle(.chatTactile(.thumbnail))
                .accessibilityLabel(String(localized: "Open media video \(reference.displayName)"))

            case .unavailable:
                TranscriptMediaUnavailableChip(reference: reference)

            case nil:
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(.systemFill))
                    .frame(width: 210, height: 132)
                    .overlay {
                        ProgressView()
                            .tint(Color(.tertiaryLabel))
                    }
            }
        }
        .task(id: reference.id) {
            resolvedMedia = nil
            guard let data = await loadMediaData(reference) else {
                guard !Task.isCancelled else { return }
                resolvedMedia = .unavailable
                return
            }

            let resolved = await Self.resolve(data)
            guard !Task.isCancelled else { return }
            resolvedMedia = resolved
        }
    }

    private func thumbnailContent(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 210, height: 132)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
            )
    }

    static func resolve(_ data: Data) async -> ResolvedMedia {
        if AttachmentAudioDetection.containerType(of: data) != nil {
            return .audio(data)
        }

#if DEBUG
        TranscriptProbeRecorder.record("imageDecode")
#endif
        if let image = await ImagePreviewDownsampler.thumbnailImage(
            from: data,
            covering: ImagePreviewDownsampler.transcriptThumbnailPixelSize
        ) {
            return .image(image)
        }

        return .video
    }

    enum ResolvedMedia {
        case image(UIImage)
        case audio(Data)
        case video
        case unavailable
    }
}
