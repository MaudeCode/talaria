import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct TranscriptMediaContentView: View {
    let segments: [TranscriptMediaSegment]
    let cacheNamespace: String
    let loadMediaImage: ((TranscriptMediaReference) async -> Data?)?
    let loadMediaData: ((TranscriptMediaReference) async -> Data?)?
    let onPreviewMedia: ((TranscriptMediaReference) -> Void)?
    let isStreaming: Bool

    init(
        segments: [TranscriptMediaSegment],
        cacheNamespace: String,
        loadMediaImage: ((TranscriptMediaReference) async -> Data?)?,
        loadMediaData: ((TranscriptMediaReference) async -> Data?)?,
        onPreviewMedia: ((TranscriptMediaReference) -> Void)?,
        isStreaming: Bool = false
    ) {
        self.segments = segments
        self.cacheNamespace = cacheNamespace
        self.loadMediaImage = loadMediaImage
        self.loadMediaData = loadMediaData
        self.onPreviewMedia = onPreviewMedia
        self.isStreaming = isStreaming
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case let .text(text):
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        MarkdownRenderer(content: text, isStreaming: isStreaming)
                    }
                case let .media(reference):
                    TranscriptMediaThumbnailView(
                        reference: reference,
                        cacheNamespace: cacheNamespace,
                        loadMediaImage: loadMediaImage,
                        loadMediaData: loadMediaData,
                        onPreviewMedia: onPreviewMedia
                    )
                    // Pin the image container LTR so media keeps its leading-edge
                    // anchor inside an RTL message (#259); the text segments above
                    // still follow the chat direction.
                    .forcedLeftToRight()
                }
            }
        }
    }
}
