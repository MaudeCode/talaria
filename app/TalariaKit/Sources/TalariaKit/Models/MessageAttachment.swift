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
