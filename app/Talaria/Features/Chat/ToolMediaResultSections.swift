import SwiftUI
import TalariaKit

/// TAL-2325: what loads and previews transcript media, so a tool row draws its media as a message body does. The chat
/// screen supplies it for its session.
struct ChatTranscriptMedia {
    let cacheNamespace: String
    let loadImage: @MainActor (TranscriptMediaReference) async -> Data?
    let loadData: @MainActor (TranscriptMediaReference) async -> Data?
    let preview: @MainActor (TranscriptMediaReference) -> Void
    var htmlPreviewURL: (@MainActor (TranscriptMediaReference) -> URL?)? = nil
}

private struct ChatTranscriptMediaKey: EnvironmentKey {
    static var defaultValue: ChatTranscriptMedia? { nil }
}

extension EnvironmentValues {
    var chatTranscriptMedia: ChatTranscriptMedia? {
        get { self[ChatTranscriptMediaKey.self] }
        set { self[ChatTranscriptMediaKey.self] = newValue }
    }
}

/// TAL-2325: the images, speech or video a media tool made, under its row without opening it: an image as the transcript's
/// thumbnail, which opens the preview, and speech and video as the transcript's players.
struct ToolResultMediaSection: View {
    let media: [TranscriptMediaReference]
    @Environment(\.chatTranscriptMedia) private var transcriptMedia

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(media) { reference in
                TranscriptMediaThumbnailView(
                    reference: reference,
                    cacheNamespace: transcriptMedia?.cacheNamespace ?? "",
                    loadMediaImage: transcriptMedia?.loadImage,
                    loadMediaData: transcriptMedia?.loadData,
                    onPreviewMedia: transcriptMedia?.preview
                )
                // Pin media LTR so it keeps its leading-edge anchor inside an RTL transcript, as a message's does.
                .forcedLeftToRight()
            }
        }
        .padding(.leading, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// TAL-2325: what an image or video analysis said, formatted.
struct ToolAnalysisSection: View {
    let analysis: String

    var body: some View {
        MarkdownRenderer(content: analysis)
            .padding(7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .chatTimelineAccessoryInsetSurface()
    }
}
