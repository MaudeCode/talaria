import Foundation

/// The installed App release's What's New announcement (TAL-1616): display-ready rows that `scripts/stamp-release.py`
/// packages into the App's Info.plist as the exact JSON `app/ci/release_notes.py` generates, shaped by
/// `contracts/whats-new.schema.json`. It needs no server, so it reads offline and before sign-in.
public struct WhatsNewAnnouncement: Decodable, Equatable, Sendable, Identifiable {
    public struct Row: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        /// A semantic icon key from the contract; the view maps it to a symbol drawn in the accent color.
        public let icon: String
        public let title: String
        public let description: String
    }

    public let schemaVersion: Int
    public let id: String
    public let component: String
    public let version: String
    public let sourceCommit: String
    public let rows: [Row]

    static let infoKey = "TalariaWhatsNew"

    /// The announcement packaged with this build, or nil when it has none or it is malformed, unsupported, or was
    /// generated for another component, version or source than the stamped release. Never throws.
    public static func installed(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> WhatsNewAnnouncement? {
        guard let text = info[infoKey] as? String,
              let announcement = try? JSONDecoder().decode(Self.self, from: Data(text.utf8)),
              announcement.schemaVersion == 1, announcement.component == "app",
              (1...4).contains(announcement.rows.count),
              announcement.version == info["CFBundleShortVersionString"] as? String,
              announcement.sourceCommit == (info["TalariaRelease"] as? [String: Any])?["sourceRevision"] as? String
        else { return nil }
        return announcement
    }

    static let lastVersionKey = "whatsNew.lastVersion"
    static let acknowledgedKey = "whatsNew.acknowledgedIDs"

    /// The installed announcement to offer at this launch (TAL-182): only after a marketing-version change from a
    /// recorded earlier one, and only until it is acknowledged. A first install, a build-only change, an acknowledged
    /// release, or missing or malformed content stays quiet and records this version as seen.
    public static func pending(info: [String: Any] = Bundle.main.infoDictionary ?? [:],
                               defaults: UserDefaults = .standard) -> WhatsNewAnnouncement? {
        guard let version = info["CFBundleShortVersionString"] as? String else { return nil }
        let lastVersion = defaults.string(forKey: lastVersionKey)
        guard lastVersion != version else { return nil }
        let announcement = installed(info: info)
        if let announcement, lastVersion != nil,
           !(defaults.stringArray(forKey: acknowledgedKey) ?? []).contains(announcement.id) {
            return announcement
        }
        announcement?.acknowledge(defaults: defaults)
        defaults.set(version, forKey: lastVersionKey)
        return nil
    }

    /// Records this announcement as seen, so no later launch of its release offers it again.
    public func acknowledge(defaults: UserDefaults = .standard) {
        var acknowledged = defaults.stringArray(forKey: Self.acknowledgedKey) ?? []
        if !acknowledged.contains(id) { acknowledged.append(id) }
        defaults.set(acknowledged, forKey: Self.acknowledgedKey)
        defaults.set(version, forKey: Self.lastVersionKey)
    }
}
