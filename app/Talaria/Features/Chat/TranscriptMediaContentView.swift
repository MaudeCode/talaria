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
    let loadMediaImage: (@MainActor (TranscriptMediaReference) async -> Data?)?
    let loadMediaData: (@MainActor (TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: (@MainActor (TranscriptMediaReference) -> Void)?
    let isStreaming: Bool
    @Environment(\.chatTranscriptMedia) private var transcriptMedia

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

            ForEach(display.tiles) { reference in
                Group {
                    if !isStreaming, let url = transcriptMedia?.htmlPreviewURL?(reference), let onPreviewMedia {
                        InlineReportView(url: url, title: reference.displayName) {
                            onPreviewMedia(reference)
                        } fallback: {
                            thumbnail(reference)
                        }
                        .id(url)
                    } else {
                        thumbnail(reference)
                    }
                }
                // Pin media LTR so it keeps its leading-edge anchor inside an RTL message (#259).
                .forcedLeftToRight()
            }
        }
    }

    private func thumbnail(_ reference: TranscriptMediaReference) -> some View {
        TranscriptMediaThumbnailView(
            reference: reference,
            cacheNamespace: cacheNamespace,
            loadMediaImage: loadMediaImage,
            loadMediaData: loadMediaData,
            onPreviewMedia: onPreviewMedia
        )
    }
}

/// An image alone in its paragraph (a list item, a quote, a link) in any chat Markdown: a body's server media shows as
/// the tappable thumbnail; any other image loads through `ChatMarkdownImageLoader`. MarkdownUI names it by its alt text.
/// `ChatMarkdownView` installs it, since MarkdownUI's innermost provider wins.
struct TranscriptMediaImageProvider: ImageProvider {
    let media: TranscriptMediaParagraphImages?

    @ViewBuilder
    func makeImage(url: URL?) -> some View {
        if let media, let reference = media.display.image(for: url) {
            MarkdownMainActorBlock {
                TranscriptMediaThumbnailView(
                    reference: reference,
                    cacheNamespace: media.cacheNamespace,
                    loadMediaImage: media.loadMediaImage,
                    loadMediaData: media.loadMediaData,
                    onPreviewMedia: media.onPreviewMedia
                )
                .forcedLeftToRight()
            }
        } else if let latex = InlineMathReference.latex(from: url) {
            // A table cell holding only math; a paragraph draws its own (`InlineMathParagraphText`).
            MarkdownMainActorBlock { InlineMathImageView(latex: latex) }
        } else if let url {
            MarkdownMainActorBlock { ChatMarkdownImage(url: url) }
        }
    }
}

/// An image inside a line of text (`**before ![x](…) after**`) in any chat Markdown: a body's server media loads through
/// the authenticated loader, shown fitted to the thumbnail box; any other image loads through `ChatMarkdownImageLoader`.
/// `ChatMarkdownView` installs it, since MarkdownUI's innermost provider wins.
struct TranscriptMediaInlineImageProvider: InlineImageProvider {
    let media: TranscriptMediaParagraphImages?
    /// Inline math in a heading or table cell; a paragraph draws its own (`InlineMathParagraphText`).
    let mathStyle: InlineMathImageStyle

    static let maxSize = CGSize(width: 210, height: 132)
    /// One transparent point: an empty `UIImage` draws a placeholder glyph in a line of text.
    private static let blank = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in }

    func image(with url: URL, label: String) async throws -> Image {
        if let latex = InlineMathReference.latex(from: url) {
            let drawing = await InlineMathImages.draw(latex, style: mathStyle)
            return Image(drawing.image, scale: drawing.scale, label: Text(verbatim: latex))
        }
        guard let media, let reference = media.display.image(for: url) else {
            // An image that does not load is left out; a throw would drop the paragraph's other images with it.
            guard let image = await ChatMarkdownImageLoader.image(from: url)?.cgImage else { return Image(uiImage: Self.blank) }
            return Image(image, scale: 1, label: Text(label))
        }
        guard let loadMediaImage = media.loadMediaImage else { throw URLError(.resourceUnavailable) }
        let key = DecodedImageCacheKey(namespace: media.cacheNamespace, resourceID: reference.id)
        guard let image = await DecodedImageCache.shared.thumbnail(
            for: key,
            covering: ImagePreviewDownsampler.transcriptThumbnailPixelSize,
            loadData: { await loadMediaImage(reference) }
        ), let cgImage = image.cgImage else { throw URLError(.cannotDecodeContentData) }
        // The cached thumbnail covers the box; a larger display scale fits it inside, never enlarging it.
        let scale = max(image.scale, CGFloat(cgImage.width) / Self.maxSize.width, CGFloat(cgImage.height) / Self.maxSize.height)
        return Image(cgImage, scale: scale, label: Text(label))
    }
}

/// The server images a paragraph's text nests inside emphasis (`**before ![x](…) after**`). MarkdownUI loads an
/// image only at a paragraph's top level, so the paragraph shows these after its text instead.
struct TranscriptMediaParagraphImages {
    let display: TranscriptDisplayBody
    let cacheNamespace: String
    let loadMediaImage: (@MainActor (TranscriptMediaReference) async -> Data?)?
    let loadMediaData: (@MainActor (TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: (@MainActor (TranscriptMediaReference) -> Void)?

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

    @MainActor func thumbnail(_ image: NestedImage) -> some View {
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
    static var defaultValue: TranscriptMediaParagraphImages? { nil }
}

extension EnvironmentValues {
    var transcriptMediaParagraphImages: TranscriptMediaParagraphImages? {
        get { self[TranscriptMediaParagraphImagesKey.self] }
        set { self[TranscriptMediaParagraphImagesKey.self] = newValue }
    }
}

/// TAL-2582: the only loader chat Markdown images other than a body's server media use (both providers above). It never
/// requests a remote image: raw Markdown, such as a streaming reply, can name one whose URL carries data a prompt
/// injection put there, and the App has no CSP to stop it. A remote image shows as a link instead
/// (`ChatMarkdownParagraph`); any other source, such as an inline `data:` image, loads through the shared session.
enum ChatMarkdownImageLoader {
    static func image(from url: URL) async -> UIImage? {
        guard !RemoteMarkdownImage.isRemote(url), let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return UIImage(data: data)
    }
}

/// A Markdown image `ChatMarkdownImageLoader` loads, at most its own size and fitted to the width; nothing until then,
/// or when it does not load, as MarkdownUI's own image did.
struct ChatMarkdownImage: View {
    let url: URL
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: image.size.width)
            } else {
                // Nothing to read: a remote image's link, which follows the paragraph, carries its alt text.
                Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
        .task(id: url) { image = await ChatMarkdownImageLoader.image(from: url) }
    }
}

/// TAL-2582: an image raw Markdown names on another host, which the App never loads; the paragraph shows it as a link to
/// the image, labelled with its alt text or else its host, as the server's display text does once a reply settles.
struct RemoteMarkdownImage: Identifiable {
    let url: URL
    let label: String
    var id: String { "\(label)\u{0}\(url.absoluteString)" }

    /// `http(s):`, or protocol-relative `//host/…`, which loads from another host too.
    static func isRemote(_ url: URL) -> Bool {
        if let scheme = url.scheme?.lowercased() { return scheme == "http" || scheme == "https" }
        return url.host != nil
    }

    /// Each remote image in a paragraph once, in order; a body's own server media is never one.
    static func all(in paragraphMarkdown: String, display: TranscriptDisplayBody?) -> [RemoteMarkdownImage] {
        guard paragraphMarkdown.contains("!["), let parsed = try? AttributedString(markdown: paragraphMarkdown) else { return [] }
        var images: [RemoteMarkdownImage] = []
        for run in parsed.runs {
            guard let url = run.imageURL, isRemote(url), display?.image(for: url) == nil else { continue }
            let alt = String(parsed[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
            let image = RemoteMarkdownImage(url: url, label: alt.isEmpty ? (url.host ?? url.absoluteString) : alt)
            if !images.contains(where: { $0.id == image.id }) { images.append(image) }
        }
        return images
    }
}

/// A remote image as a link to it; it opens through the chat's own link handling.
struct RemoteMarkdownImageLink: View {
    let image: RemoteMarkdownImage

    var body: some View {
        Link(destination: image.url) {
            Label(image.label, systemImage: "photo")
        }
        // The paragraph's text styles would draw it as body text; it reads as a link.
        .foregroundStyle(.tint)
        .accessibilityLabel(image.label)
    }
}
