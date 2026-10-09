import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-186: an assistant body with server media renders as one Markdown document. Each image the server rewrote,
/// wherever the Markdown puts it, loads through the authenticated transcript loader as the server's item; the
/// App recognizes nothing in the text itself.
@MainActor
final class TranscriptMediaRenderingTests: XCTestCase {
    func testEveryImageTheServerRewroteLoadsThroughTheAuthenticatedLoader() throws {
        let constructs = ["bold", "list", "quote", "linked", "inline"]
        let media = constructs.map { name in
            TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2F\(name).png&session_id=s1", name: "\(name).png", mime: "image/png", mediaKind: .image)
        }
        let audio = TranscriptMediaReference(url: "./api/media?path=%2Ftmp%2Fclip.mp3&session_id=s1", name: "clip.mp3", mime: "audio/mpeg", mediaKind: .audio)
        let display = TranscriptDisplayBody(text: """
        **before ![Bold](\(media[0].url)) after**

        Plain text ![Inline](\(media[4].url)) around an image.

        - ![List](\(media[1].url))

        > ![Quote](\(media[2].url))

        [![Linked](\(media[3].url))](https://example.invalid/linked)

        Narration: [clip.mp3](\(audio.url))
        """, media: media + [audio])
        let message = ChatMessage(
            role: "assistant",
            content: "**before MEDIA:/tmp/bold.png after** …",
            timestamp: nil,
            messageId: "media-reply",
            displayBody: display
        )
        let loads = LoadRecorder()

        try hostInOwnWindow(MessageBubbleView(
            message: message,
            loadTranscriptMediaImage: { reference in
                loads.record(reference.url)
                return TestPNG.data
            },
            loadTranscriptMediaData: { _ in nil },
            // A fresh namespace: the decoded-image cache must not answer for another test's run.
            transcriptMediaCacheNamespace: "https://example.invalid|\(UUID().uuidString)"
        ), size: CGSize(width: 360, height: 900))

        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if Set(loads.urls) == Set(media.map(\.url)) { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertEqual(Set(loads.urls), Set(media.map(\.url)), "Each construct's image loads as the server's item")
        XCTAssertFalse(loads.urls.contains(audio.url), "Audio renders as a tile, not an inline image")
    }
}

@MainActor
private final class LoadRecorder {
    private(set) var urls: [String] = []
    func record(_ url: String) { urls.append(url) }
}

private enum TestPNG {
    static let data: Data = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 16)).pngData { context in
        UIColor.systemTeal.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 24, height: 16))
    }
}
