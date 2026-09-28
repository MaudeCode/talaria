import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct TranscriptMediaThumbnailView: View {
    let reference: TranscriptMediaReference
    let cacheNamespace: String
    let loadMediaImage: ((TranscriptMediaReference) async -> Data?)?
    let loadMediaData: ((TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: ((TranscriptMediaReference) -> Void)?

    @State private var image: UIImage?
    @State private var didAttemptLoad = false

    private let thumbnailWidth: CGFloat = 210
    private let thumbnailHeight: CGFloat = 132

    var body: some View {
        switch reference.mediaKind {
        case .image where reference.isExtensionlessRemoteMediaCandidate && loadMediaData != nil:
            if let loadMediaData {
                TranscriptMediaResolvedRemoteView(
                    reference: reference,
                    loadMediaData: loadMediaData,
                    onPreviewMedia: onPreviewMedia
                )
            } else {
                TranscriptMediaUnavailableChip(reference: reference)
            }

        case .image where loadMediaImage != nil:
            Button {
                onPreviewMedia?(reference)
            } label: {
                thumbnailContent
            }
            .buttonStyle(.chatTactile(.thumbnail))
            .accessibilityLabel(imageButtonAccessibilityLabel)
            .task(id: imageCacheKey) {
                guard let loadMediaImage else { return }
                image = nil
                didAttemptLoad = false
                let loadedImage = await DecodedImageCache.shared.image(for: imageCacheKey) {
                    guard let data = await loadMediaImage(reference) else { return nil }
                    return UIImage(data: data)
                }
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    image = loadedImage
                    didAttemptLoad = true
                }
            }
        case .audio where loadMediaData != nil:
            if let loadMediaData {
                TranscriptMediaAudioExportView(
                    reference: reference,
                    loadMediaData: {
                        await loadMediaData(reference)
                    }
                )
            } else {
                TranscriptMediaUnavailableChip(reference: reference)
            }

        case .video:
            Button {
                onPreviewMedia?(reference)
            } label: {
                TranscriptMediaVideoTile(reference: reference)
            }
            .buttonStyle(.chatTactile(.thumbnail))
            .accessibilityLabel(String(localized: "Open media video \(reference.displayName)"))

        case .unsupported where loadMediaData != nil:
            if let loadMediaData {
                TranscriptMediaFileExportView(
                    reference: reference,
                    loadMediaData: {
                        await loadMediaData(reference)
                    }
                )
            } else {
                TranscriptMediaUnavailableChip(reference: reference)
            }

        default:
            TranscriptMediaUnavailableChip(reference: reference)
        }
    }

    private var imageCacheKey: DecodedImageCacheKey {
        DecodedImageCacheKey(namespace: cacheNamespace, resourceID: reference.id)
    }

    private var imageButtonAccessibilityLabel: String {
        if image == nil, didAttemptLoad, reference.isExtensionlessRemoteMediaCandidate {
            return String(localized: "Open media video \(reference.displayName)")
        }

        return String(localized: "Open media image \(reference.accessibilityName)")
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: thumbnailWidth, height: thumbnailHeight)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
                )
        } else if didAttemptLoad {
            if reference.isExtensionlessRemoteMediaCandidate {
                TranscriptMediaVideoTile(reference: reference)
            } else {
                TranscriptMediaUnavailableChip(reference: reference)
            }
        } else {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(.systemFill))
                .frame(width: thumbnailWidth, height: thumbnailHeight)
                .overlay {
                    ProgressView()
                        .tint(Color(.tertiaryLabel))
                }
        }
    }
}
