public import Foundation
import CryptoKit

/// The latest successful response of each kind, per server and active profile, kept as the
/// server's own bytes so a screen can show it on the next launch before the network answers
/// (TAL-437). Decoding goes through `APIClient.responseDecoder()`, so cached data reads exactly
/// like a live response.
/// `serverScopedStateReset` clears a server's entries with everything else it owns. Every kind
/// but the profile list comes from the active profile's home, so each profile keeps its own
/// entries and a switch never shows another profile's (TAL-553).
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
            "kanban-board-" + ResponseCache.hex(slug)
        }
    }

    public func entry(_ kind: String) -> Entry {
        guard kind != Kind.profiles else {
            return Entry(url: directory.appendingPathComponent("\(kind).json"), server: server, generation: generation)
        }
        let profile = ActiveServerProfile.name(for: server)
        let folder = directory.appendingPathComponent("profile-" + Self.hex(profile ?? ""), isDirectory: true)
        return Entry(
            url: folder.appendingPathComponent("\(kind).json"),
            server: server,
            generation: generation,
            profile: .some(profile)
        )
    }

    /// Deletes every cached response for this server, for every profile.
    public func clear() {
        try? FileManager.default.removeItem(at: directory)
        ActiveServerProfile.record(nil, for: server)
    }

    public struct Entry: Sendable {
        let url: URL
        let server: URL
        let generation: Int
        /// The active profile the entry was resolved for; nil for the server-wide profile list.
        var profile: String?? = nil

        public func load<Response: Decodable>(_ type: Response.Type) -> Response? {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? APIClient.responseDecoder().decode(type, from: data)
        }

        func save(_ data: Data) {
            // A response that was in flight across a profile switch may belong to either profile.
            guard ServerCacheGeneration.current(for: server) == generation,
                  profile.map({ $0 == ActiveServerProfile.name(for: server) }) ?? true
            else { return }
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    /// Hex-encodes a name so any value is a safe file name.
    static func hex(_ name: String) -> String {
        Data(name.utf8).map { String(format: "%02x", $0) }.joined()
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

/// The profile each server last reported active to this app (TAL-553). `APIClient` records it from
/// every profile list and switch; `ResponseCache` keeps each profile's entries apart by it. Stored
/// so the first screen after launch reads the right profile's entries before the network answers.
enum ActiveServerProfile {
    private static let storageKey = "responseCache.activeProfile.v1"
    private static let lock = NSLock()
    nonisolated(unsafe) private static var switches: [String: Int] = [:]

    static func name(for server: URL) -> String? {
        UserDefaults.standard.dictionary(forKey: storageKey)?[server.absoluteString] as? String
    }

    /// Counts the server's switches, so a profile list can tell whether one landed while it was
    /// in flight.
    static func switchCount(for server: URL) -> Int {
        lock.withLock { switches[server.absoluteString, default: 0] }
    }

    /// Records a profile list's active profile, unless a switch landed after `switchCount` was
    /// read: that list predates the switch and reports the old profile.
    static func record(_ name: String?, for server: URL, ifNoSwitchSince switchCount: Int) {
        lock.withLock {
            guard switches[server.absoluteString, default: 0] == switchCount else { return }
            store(name, for: server)
        }
    }

    /// Records a completed switch, or forgets the server's profile when `name` is nil.
    static func record(_ name: String?, for server: URL) {
        lock.withLock {
            switches[server.absoluteString, default: 0] += 1
            store(name, for: server)
        }
    }

    private static func store(_ name: String?, for server: URL) {
        var names = UserDefaults.standard.dictionary(forKey: storageKey) ?? [:]
        names[server.absoluteString] = name
        UserDefaults.standard.set(names, forKey: storageKey)
    }
}
