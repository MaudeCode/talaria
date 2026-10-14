import Foundation

/// TAL-831: an out-of-band notice the Agent raised for the session (a memory provider that failed to load, a credit
/// warning), one per `key` (session `notices`, SSE `notices`). The server keeps the list and clears it; the App shows
/// it. Decoded with `convertFromSnakeCase`.
public struct SessionNotice: Decodable, Equatable, Hashable {
    public enum Level: String, Equatable, Hashable {
        case info, warn, error, success
    }

    public let key: String
    public let level: Level
    public let text: String

    public init(key: String, level: Level, text: String) {
        self.key = key
        self.level = level
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case key, level, text
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let key = container.decodeLossyStringIfPresent(forKey: .key), !key.isEmpty,
              let text = container.decodeLossyStringIfPresent(forKey: .text), !text.isEmpty
        else {
            throw DecodingError.dataCorruptedError(forKey: .key, in: container, debugDescription: "A notice needs its key and text")
        }
        self.key = key
        self.text = text
        level = container.decodeLossyStringIfPresent(forKey: .level).flatMap(Level.init(rawValue:)) ?? .info
    }
}

/// TAL-831: the session's notices changed (SSE `notices`); `notices` replaces the session's list.
public struct SessionNoticesEvent: Decodable, Equatable {
    public let sessionId: String?
    public let notices: [SessionNotice]

    public init(sessionId: String?, notices: [SessionNotice]) {
        self.sessionId = sessionId
        self.notices = notices
    }

    enum CodingKeys: String, CodingKey {
        case sessionId, notices
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
        // One malformed entry never hides the others; a frame without the list says nothing.
        guard let notices = container.decodeLossyArrayIfPresent(SessionNotice.self, forKey: .notices) else {
            throw DecodingError.keyNotFound(CodingKeys.notices, .init(codingPath: decoder.codingPath, debugDescription: "No notices"))
        }
        self.notices = notices
    }
}
