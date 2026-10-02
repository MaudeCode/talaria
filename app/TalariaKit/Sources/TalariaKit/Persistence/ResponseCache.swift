public import Foundation
import CryptoKit

/// The latest successful response of each kind, per server, kept as the server's own bytes so a
/// screen can show it on the next launch before the network answers (TAL-437). Decoding goes
/// through `APIClient.responseDecoder()`, so cached data reads exactly like a live response.
/// `serverScopedStateReset` clears a server's entries with everything else it owns.
public struct ResponseCache: Sendable {
    private let directory: URL

    /// - Parameter root: tests pass a temporary directory; the app uses its Caches directory.
    public init(server: URL, root: URL? = nil) {
        let base = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ResponseCache", isDirectory: true)
        directory = base.appendingPathComponent(Self.folderName(for: server), isDirectory: true)
    }

    /// One file per endpoint; screens that read the same endpoint share its entry.
    public enum Kind {
        public static let profiles = "profiles"
        public static let projects = "projects"
        public static let models = "models"
        public static let workspaces = "workspaces"
        public static let commands = "commands"
    }

    public func entry(_ kind: String) -> Entry {
        Entry(url: directory.appendingPathComponent("\(kind).json"))
    }

    /// Deletes every cached response for this server.
    public func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    public struct Entry: Sendable {
        let url: URL

        public func load<Response: Decodable>(_ type: Response.Type) -> Response? {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? APIClient.responseDecoder().decode(type, from: data)
        }

        func save(_ data: Data) {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private static func folderName(for server: URL) -> String {
        SHA256.hash(data: Data(server.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
