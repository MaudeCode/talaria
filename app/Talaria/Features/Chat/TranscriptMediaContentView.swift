import MarkdownUI
import SwiftUI
import UIKit
import TalariaKit

/// A body the server rewrote for display (TAL-186), as one Markdown document: its images load inline,
/// where the text puts them, through the authenticated transcript loader, and its other media follows as tiles.
struct TranscriptMediaContentView: View {
    let markdown: String
    let display: TranscriptDisplayBody
    let cacheNamespace: String
    let loadMediaImage: ((TranscriptMediaReference) async -> Data?)?
    let loadMediaData: ((TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: ((TranscriptMediaReference) -> Void)?
    let isStreaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownRenderer(content: markdown, isStreaming: isStreaming)
                .environment(\.transcriptMediaParagraphImages, TranscriptMediaParagraphImages(
                    display: display,
                    cacheNamespace: cacheNamespace,
                    loadMediaImage: loadMediaImage,
                    loadMediaData: loadMediaData,
                    onPreviewMedia: onPreviewMedia
                ))
                .markdownImageProvider(TranscriptMediaImageProvider(
                    display: display,
                    cacheNamespace: cacheNamespace,
                    loadMediaImage: loadMediaImage,
                    loadMediaData: loadMediaData,
                    onPreviewMedia: onPreviewMedia
                ))
                .markdownInlineImageProvider(TranscriptMediaInlineImageProvider(
                    display: display,
                    cacheNamespace: cacheNamespace,
                    loadMediaImage: loadMediaImage
                ))

            ForEach(display.tiles) { reference in
                TranscriptMediaThumbnailView(
                    reference: reference,
                    cacheNamespace: cacheNamespace,
                    loadMediaImage: loadMediaImage,
                    loadMediaData: loadMediaData,
                    onPreviewMedia: onPreviewMedia
                )
                // Pin media LTR so it keeps its leading-edge anchor inside an RTL message (#259).
                .forcedLeftToRight()
            }
        }
    }
}

/// An image alone in its paragraph (a list item, a quote, a link): the body's server media shows as the
/// tappable thumbnail; any other image loads as MarkdownUI would. MarkdownUI names it by its alt text.
struct TranscriptMediaImageProvider: ImageProvider {
    let display: TranscriptDisplayBody
    let cacheNamespace: String
    let loadMediaImage: ((TranscriptMediaReference) async -> Data?)?
    let loadMediaData: ((TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: ((TranscriptMediaReference) -> Void)?

    @ViewBuilder
    func makeImage(url: URL?) -> some View {
        if let reference = display.image(for: url) {
            TranscriptMediaThumbnailView(
                reference: reference,
                cacheNamespace: cacheNamespace,
                loadMediaImage: loadMediaImage,
                loadMediaData: loadMediaData,
                onPreviewMedia: onPreviewMedia
            )
            .forcedLeftToRight()
        } else {
            DefaultImageProvider.default.makeImage(url: url)
        }
    }
}

/// An image inside a line of text (`**before ![x](…) after**`): the body's server media loads through the
/// authenticated loader, fitted to the thumbnail box; any other image loads as MarkdownUI would.
struct TranscriptMediaInlineImageProvider: InlineImageProvider {
    let display: TranscriptDisplayBody
    let cacheNamespace: String
    let loadMediaImage: ((TranscriptMediaReference) async -> Data?)?

    static let maxSize = CGSize(width: 210, height: 132)

    func image(with url: URL, label: String) async throws -> Image {
        guard let reference = display.image(for: url) else {
            return try await DefaultInlineImageProvider.default.image(with: url, label: label)
        }
        guard let loadMediaImage else { throw URLError(.resourceUnavailable) }
        let key = DecodedImageCacheKey(namespace: cacheNamespace, resourceID: reference.id)
        guard let image = await DecodedImageCache.shared.image(for: key, load: {
            guard let data = await loadMediaImage(reference) else { return nil }
            return UIImage(data: data)
        }) else { throw URLError(.cannotDecodeContentData) }
        let fitted = Self.fitted(image)
        guard let cgImage = fitted.cgImage else { throw URLError(.cannotDecodeContentData) }
        return Image(cgImage, scale: fitted.scale, label: Text(label))
    }

    /// The image scaled down, never up, to fit `maxSize` at the screen's scale.
    static func fitted(_ image: UIImage) -> UIImage {
        let scale = min(1, maxSize.width / max(image.size.width, 1), maxSize.height / max(image.size.height, 1))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}

/// The server images a paragraph's text nests inside emphasis (`**before ![x](…) after**`). MarkdownUI loads an
/// image only at a paragraph's top level, so the paragraph shows these after its text instead.
struct TranscriptMediaParagraphImages {
    let display: TranscriptDisplayBody
    let cacheNamespace: String
    let loadMediaImage: ((TranscriptMediaReference) async -> Data?)?
    let loadMediaData: ((TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: ((TranscriptMediaReference) -> Void)?

    /// Each nested server image once, with its alt text, which stays its accessibility name.
    func nestedImages(in paragraphMarkdown: String) -> [NestedImage] {
        guard paragraphMarkdown.contains("!["),
              let parsed = try? AttributedString(markdown: paragraphMarkdown)
        else { return [] }
        var images: [NestedImage] = []
        for run in parsed.runs where !(run.inlinePresentationIntent ?? []).isEmpty {
            if let image = display.image(for: run.imageURL), !images.contains(where: { $0.id == image.id }) {
                let alt = String(parsed[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                images.append(NestedImage(reference: image, alt: alt.isEmpty ? image.accessibilityName : alt))
            }
        }
        return images
    }

    func thumbnail(_ image: NestedImage) -> some View {
        TranscriptMediaThumbnailView(
            reference: image.reference,
            cacheNamespace: cacheNamespace,
            loadMediaImage: loadMediaImage,
            loadMediaData: loadMediaData,
            onPreviewMedia: onPreviewMedia
        )
        .accessibilityLabel(image.alt)
        .forcedLeftToRight()
    }

    struct NestedImage: Identifiable {
        let reference: TranscriptMediaReference
        let alt: String
        var id: String { reference.id }
    }
}

private struct TranscriptMediaParagraphImagesKey: EnvironmentKey {
    static let defaultValue: TranscriptMediaParagraphImages? = nil
}

extension EnvironmentValues {
    var transcriptMediaParagraphImages: TranscriptMediaParagraphImages? {
        get { self[TranscriptMediaParagraphImagesKey.self] }
        set { self[TranscriptMediaParagraphImagesKey.self] = newValue }
    }
}
