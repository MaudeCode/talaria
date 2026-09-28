import Foundation

public struct MessageAttachment: Codable, Equatable {
    public let name: String?
    public let path: String?
    public let mime: String?
    public let size: Int?
    public let isImage: Bool?

    public init(
        name: String? = nil,
        path: String? = nil,
        mime: String? = nil,
        size: Int? = nil,
        isImage: Bool? = nil
    ) {
        self.name = name
        self.path = path
        self.mime = mime
        self.size = size
        self.isImage = isImage
    }

    public init(from decoder: Decoder) throws {
        // Tolerant decoding: upstream may store bare filenames (legacy) or
        // objects with unexpected field names / types. Never crash the parent
        // ChatMessage decode because of one malformed attachment.

        // Some old server data stores attachments as bare strings.
        if let bareName = try? decoder.singleValueContainer().decode(String.self) {
            self.name = bareName
            self.path = nil
            self.mime = nil
            self.size = nil
            self.isImage = nil
            return
        }

        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.name = container.decodeLossyStringIfPresent(forKey: .name)
            ?? container.decodeLossyStringIfPresent(forKey: .filename)
        self.path = container.decodeLossyStringIfPresent(forKey: .path)
        self.mime = container.decodeLossyStringIfPresent(forKey: .mime)
        self.size = container.decodeLossyIntIfPresent(forKey: .size)
        self.isImage = container.decodeLossyBoolIfPresent(forKey: .isImage)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(path, forKey: .path)
        try container.encodeIfPresent(mime, forKey: .mime)
        try container.encodeIfPresent(size, forKey: .size)
        try container.encodeIfPresent(isImage, forKey: .isImage)
    }

    enum CodingKeys: String, CodingKey {
        case name
        case filename
        case path
        case mime
        case size
        case isImage
    }
}

extension MessageAttachment {
    /// Stable identity for matching the *same* attachment across two
    /// representations — e.g. an optimistic local bubble against its
    /// server-reloaded copy. Uses the lowercased last path component (basename)
    /// of the first non-empty `name`/`path`, NOT the raw value: the server
    /// returns an attachment's `path` inconsistently on reload — usually a bare
    /// filename, occasionally the full upload path — so comparing raw values
    /// fails to match an optimistic bubble (full upload path) against its
    /// reloaded copy (bare filename). Voice notes are the live case: #330
    /// dropped their `[Attached files: <path>]` marker, which had silently
    /// backfilled the path on reload, so basename matching is now the only
    /// reliable key. Returns `nil` when the attachment carries no usable
    /// name or path.
    public var identityKey: String? {
        let raw = [name, path]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        guard let raw else { return nil }
        let lastComponent = URL(fileURLWithPath: raw).lastPathComponent
        let value = (lastComponent.isEmpty ? raw : lastComponent).lowercased()
        return value.isEmpty ? nil : value
    }
}

extension MessageAttachment {
    static func inferredFromAttachedFilesMarker(in content: String?) -> [MessageAttachment]? {
        guard let content,
              let marker = attachedFilesMarker(in: content)
        else {
            return nil
        }

        let inferredDirectory = marker.references
            .first(where: { $0.contains("/") })
            .map { URL(fileURLWithPath: $0).deletingLastPathComponent().path }

        let attachments = marker.references.map { reference in
            let name = displayName(for: reference)
            let path = inferredPath(for: reference, fallbackDirectory: inferredDirectory)
            return MessageAttachment(
                name: name,
                path: path,
                mime: nil,
                size: nil,
                isImage: isImageReference(reference)
            )
        }

        return attachments.isEmpty ? nil : attachments
    }

    /// Returns the message text with the trailing `[Attached files: …]` marker
    /// (and the blank-line separator it was appended after) removed, for the
    /// display layer to render. Reuses the same parser as attachment inference
    /// so the two can never disagree about what counts as a marker. The sent
    /// payload is built elsewhere and is unaffected by this display transform.
    static func contentWithoutAttachedFilesMarker(in content: String) -> String {
        guard let marker = attachedFilesMarker(in: content) else {
            return content
        }

        // The parser rejects any non-whitespace after the closing bracket, so
        // the marker is always a suffix; everything before it is the user's
        // typed message. Drop the trailing separator whitespace as well.
        var prefix = content[..<marker.range.lowerBound]
        while let last = prefix.last, last.isWhitespace {
            prefix = prefix.dropLast()
        }
        return String(prefix)
    }

    /// The two halves of the WebUI's message for a textless send, built by
    /// `PendingAttachment.chatMessageText` and parsed back here.
    static let uploadedFilesPrefix = "I've uploaded "
    static let uploadedFilesInfix = " file(s): "

    /// True when `content` is the message an attachment-only send produces *for
    /// these attachments*: it has the WebUI's synthesized shape and names every
    /// one of them. The shape alone is not evidence — pasted prose or a voice
    /// note's bare transcript can wear it — so each attachment's identity key
    /// must appear in the text. That is a containment check rather than a parse
    /// of the reference list, so duplicate filenames, commas inside a filename,
    /// and the server rewriting paths to bare filenames on reload all still
    /// match, while a voice note (whose transcript never names its audio clip)
    /// and any unattached message do not.
    static func isSynthesizedUploadMessage(
        _ content: String,
        attachments: [MessageAttachment]?
    ) -> Bool {
        guard let attachments,
              !attachments.isEmpty,
              // A synthesized message is the whole content: text the user typed
              // still carries its references in a trailing marker instead.
              contentWithoutAttachedFilesMarker(in: content) == content,
              uploadedFilesMessage(in: content) != nil
        else {
            return false
        }

        let lowercasedContent = content.lowercased()
        return attachments.allSatisfy { attachment in
            guard let key = attachment.identityKey else { return false }
            return lowercasedContent.contains(key)
        }
    }

    /// Display text for a user bubble that hides attachment paths. Strips the
    /// `[Attached files: …]` marker, and — for the server's replayed copy of an
    /// attachment-only send, whose whole content is the synthesized message —
    /// everything, leaving the attachment chips to speak for themselves. The
    /// optimistic bubble already carries no text; this keeps the row looking the
    /// same after a reload. The sent payload is unaffected.
    public static func contentWithoutAttachmentReferences(
        in content: String,
        attachments: [MessageAttachment]?
    ) -> String {
        isSynthesizedUploadMessage(content, attachments: attachments)
            ? ""
            : contentWithoutAttachedFilesMarker(in: content)
    }

    private static func attachedFilesMarker(
        in content: String
    ) -> (range: Range<String.Index>, references: [String])? {
        guard let markerRange = content.range(of: "[Attached files:", options: .backwards) else {
            return nil
        }

        let afterMarker = content[markerRange.upperBound...]
        guard let closeBracket = afterMarker.firstIndex(of: "]") else {
            return nil
        }

        let afterBracket = afterMarker[afterMarker.index(after: closeBracket)...]
        guard afterBracket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        let references = afterMarker[..<closeBracket]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let markerEnd = afterMarker.index(after: closeBracket)
        return (markerRange.lowerBound..<markerEnd, references)
    }

    /// Matches `I've uploaded <count> file(s): <references>` — the whole
    /// message a textless send carries, since there is no typed text to append
    /// a `[Attached files: …]` marker to. Anchored at both ends and requiring a
    /// numeric count; the caller supplies the rest of the evidence that this is
    /// really an attachment-only send.
    private static func uploadedFilesMessage(
        in content: String
    ) -> (range: Range<String.Index>, references: [String])? {
        guard content.hasPrefix(uploadedFilesPrefix) else { return nil }

        let afterPrefix = content.dropFirst(uploadedFilesPrefix.count)
        guard let infix = afterPrefix.range(of: uploadedFilesInfix) else { return nil }

        let count = afterPrefix[..<infix.lowerBound]
        guard !count.isEmpty, count.allSatisfy(\.isNumber) else { return nil }

        let references = afterPrefix[infix.upperBound...]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !references.isEmpty else { return nil }

        return (content.startIndex..<content.endIndex, references)
    }

    private static func displayName(for reference: String) -> String {
        let lastPathComponent = URL(fileURLWithPath: reference).lastPathComponent
        return lastPathComponent.isEmpty ? reference : lastPathComponent
    }

    private static func inferredPath(for reference: String, fallbackDirectory: String?) -> String? {
        if reference.contains("/") {
            return reference
        }

        guard isImageReference(reference),
              let fallbackDirectory,
              !fallbackDirectory.isEmpty
        else {
            return nil
        }

        return URL(fileURLWithPath: fallbackDirectory)
            .appendingPathComponent(reference)
            .path
    }

    private static func isImageReference(_ reference: String) -> Bool {
        let ext = URL(fileURLWithPath: reference).pathExtension.lowercased()
        return ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"].contains(ext)
    }
}
