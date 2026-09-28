import SwiftUI
import TalariaKit

struct RemoteAttachmentImage: View {
    let path: String
    let cacheNamespace: String
    let loadAttachmentImage: (String) async -> Data?
    @State private var image: UIImage?
    @State private var didAttempt = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if !didAttempt {
                placeholderImage
            } else {
                fallbackImage
            }
        }
        .task(id: imageCacheKey) {
            let loaded = await DecodedImageCache.shared.image(for: imageCacheKey) {
                guard let data = await loadAttachmentImage(path) else { return nil }
                let previewData = ImagePreviewDownsampler.previewData(
                    from: data,
                    maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
                ) ?? data
                return UIImage(data: previewData)
            }
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self.image = loaded
                self.didAttempt = true
            }
        }
    }

    private var imageCacheKey: DecodedImageCacheKey {
        DecodedImageCacheKey(namespace: cacheNamespace, resourceID: path)
    }

    private var fallbackImage: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(.systemFill))
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 24, weight: .regular))
                    .foregroundStyle(Color(.tertiaryLabel))
            )
    }

    private var placeholderImage: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(.systemFill))
            .overlay(
                ProgressView()
                    .tint(Color(.tertiaryLabel))
            )
    }
}
