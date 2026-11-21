import Foundation

public enum TranscriptLinkPreviewEligibility {
    /// The server chooses the URL (TAL-2504) and leaves collapsed bodies without one (TAL-456); a streaming row waits to settle.
    public static func previewURL(for message: ChatMessage, isStreaming: Bool) -> URL? {
        isStreaming ? nil : message.linkPreviewURL
    }
}
