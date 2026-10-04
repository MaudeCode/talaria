import Foundation

public enum TranscriptMediaKind: String, Codable, Equatable {
    case image
    case audio
    case video
    case unsupported
}

/// One media item the server resolved in a message's text (`_media`, TAL-186). The server decides
/// which references exist, where they load from and their kind; the app renders them as sent.
public struct TranscriptMediaReference: Codable, Equatable, Identifiable {
    /// Relative to the server root (`./api/media?…`) or a remote `http(s)` URL, as the server sent it.
    public let url: String
    public let name: String
    public let mime: String
    public let mediaKind: TranscriptMediaKind

    public init(url: String, name: String, mime: String = "application/octet-stream", mediaKind: TranscriptMediaKind) {
        self.url = url
        self.name = name
        self.mime = mime
        self.mediaKind = mediaKind
    }

    public var id: String {
        url
    }

    public var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(localized: "Media") : trimmed
    }

    public var accessibilityName: String {
        displayName
    }

    var isRasterImageCandidate: Bool {
        mediaKind == .image
    }

    /// The file name's extension, lowercased; empty when it has none.
    var fileExtension: String {
        URL(fileURLWithPath: name).pathExtension.lowercased()
    }

    /// Items decode one by one, so a malformed item never drops its neighbours.
    static func decodeLossily(_ values: [JSONValue]?) -> [TranscriptMediaReference] {
        (values ?? []).compactMap { value in
            guard case let .object(object) = value,
                  case let .string(url)? = object["url"],
                  !url.isEmpty
            else { return nil }
            let string: (String) -> String = { key in
                if case let .string(value)? = object[key] { return value }
                return ""
            }
            let kind: TranscriptMediaKind = switch string("kind") {
            case "image": .image
            case "audio": .audio
            case "video": .video
            default: .unsupported
            }
            return TranscriptMediaReference(url: url, name: string("name"), mime: string("mime"), mediaKind: kind)
        }
    }
}

/// The server's display text for a body, with its media references rewritten to Markdown that
/// points at their URLs, and the media it references (TAL-186). The body's own text stays for copy and edit.
public struct TranscriptDisplayBody: Codable, Equatable {
    public let text: String
    public let media: [TranscriptMediaReference]

    public init(text: String, media: [TranscriptMediaReference]) {
        self.text = text
        self.media = media
    }

    /// The server's fields as decoded; nil when it sent no display text.
    static func decoded(text: String?, media: [JSONValue]?) -> TranscriptDisplayBody? {
        guard let text else { return nil }
        return TranscriptDisplayBody(text: text, media: TranscriptMediaReference.decodeLossily(media))
    }

    /// The referenced media that is not an inline image, shown as tiles after the text.
    public var tiles: [TranscriptMediaReference] {
        media.filter { $0.mediaKind != .image }
    }

    /// The server's image item for a Markdown image URL in `text`, if it is one of this body's.
    public func image(for url: URL?) -> TranscriptMediaReference? {
        guard let url else { return nil }
        let source = url.relativeString
        return media.first { $0.mediaKind == .image && ($0.url == source || $0.url == url.absoluteString) }
    }
}
