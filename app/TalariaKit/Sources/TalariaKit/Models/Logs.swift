import Foundation

/// The raw tail remains independent of the server's optional classified entries.
public struct LogsResponse: Decodable, Equatable, Sendable {
    public let lines: [String]
    public let totalBytes: Int?
    public let mtime: Double?
    public let truncated: Bool?
    public let hint: String?
    public let files: [File]?

    public struct File: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
    }

    private enum CodingKeys: String, CodingKey {
        case lines, totalBytes, mtime, truncated, hint, files
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        lines = container.decodeLossyArrayIfPresent(String.self, forKey: .lines) ?? []
        totalBytes = container.decodeLossyIntIfPresent(forKey: .totalBytes)
        mtime = container.decodeLossyDoubleIfPresent(forKey: .mtime)
        truncated = container.decodeLossyBoolIfPresent(forKey: .truncated)
        hint = container.decodeLossyStringIfPresent(forKey: .hint)
        files = container.decodeLossyArrayIfPresent(File.self, forKey: .files)
    }
}
