public import Foundation
import CryptoKit

/// The latest successful response of each kind, per server, kept as the server's own bytes so a
/// screen can show it on the next launch before the network answers (TAL-437). Decoding goes
/// through `APIClient.responseDecoder()`, so cached data reads exactly like a live response.
/// `serverScopedStateReset` clears a server's entries with everything else it owns.
public struct ResponseCache: Sendable {
    private let directory: URL
    private let server: URL
    private let generation: Int

    /// - Parameter root: tests pass a temporary directory; the app uses its Caches directory.
    public init(server: URL, root: URL? = nil) {
        let base = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ResponseCache", isDirectory: true)
        directory = base.appendingPathComponent(Self.folderName(for: server), isDirectory: true)
        self.server = server
        generation = ServerCacheGeneration.current(for: server)
    }

    /// One file per endpoint; screens that read the same endpoint share its entry.
    public enum Kind {
        public static let profiles = "profiles"
        public static let projects = "projects"
        public static let models = "models"
        public static let workspaces = "workspaces"
        public static let commands = "commands"
        public static let crons = "crons"
        public static let skills = "skills"
        public static let memory = "memory"
        public static let kanbanConfiguration = "kanban-config"
        public static let kanbanBoards = "kanban-boards"

        /// One entry per board; the slug is hex-encoded so any slug is a safe file name.
        public static func kanbanBoard(_ slug: String) -> String {
            "kanban-board-" + Data(slug.utf8).map { String(format: "%02x", $0) }.joined()
        }
    }

    public func entry(_ kind: String) -> Entry {
        Entry(url: directory.appendingPathComponent("\(kind).json"), server: server, generation: generation)
    }

    /// Deletes every cached response for this server.
    public func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    public struct Entry: Sendable {
        let url: URL
        let server: URL
        let generation: Int

        public func load<Response: Decodable>(_ type: Response.Type) -> Response? {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? APIClient.responseDecoder().decode(type, from: data)
        }

        func save(_ data: Data) {
            guard ServerCacheGeneration.current(for: server) == generation else { return }
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

/// Counts each server's cache resets. A screen captures the count when it is created and writes
/// only while it is unchanged, so an old screen closing, or a response still in flight, cannot put
/// the previous identity's data back after a sign-in as another profile (TAL-437).
public enum ServerCacheGeneration {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var generations: [String: Int] = [:]

    public static func current(for server: URL) -> Int {
        lock.withLock { generations[server.absoluteString, default: 0] }
    }

    static func advance(for server: URL) {
        lock.withLock { generations[server.absoluteString, default: 0] += 1 }
    }
}
