import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct TranscriptMediaResolvedRemoteView: View {
    let reference: TranscriptMediaReference
    let loadMediaData: (TranscriptMediaReference) async -> Data?
    let onPreviewMedia: ((TranscriptMediaReference) -> Void)?

    @State private var resolvedMedia: ResolvedMedia?

    var body: some View {
        Group {
            switch resolvedMedia {
            case let .image(image):
                Button {
                    onPreviewMedia?(reference)
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
                    onPreviewMedia?(reference)
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

            guard !Task.isCancelled else { return }
            resolvedMedia = Self.resolve(data)
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

    private static func resolve(_ data: Data) -> ResolvedMedia {
        if let image = UIImage(data: data) {
            return .image(image)
        }

        if (try? AVAudioPlayer(data: data)) != nil {
            return .audio(data)
        }

        return .video
    }

    private enum ResolvedMedia {
        case image(UIImage)
        case audio(Data)
        case video
        case unavailable
    }
}
