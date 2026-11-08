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
    static let acknowledgedRowsKey = "whatsNew.acknowledgedRowIDs"

    /// The installed announcement's rows not yet acknowledged, to offer at this launch (TAL-182, TAL-1980). Rows, not
    /// releases, are acknowledged, so a later Nightly of one marketing version or an update that skipped releases
    /// offers exactly the rows this install has not seen. A first run, when neither the version nor any row was ever
    /// recorded, introduces nothing and records every packaged row; missing or malformed content stays quiet.
    public static func pending(info: [String: Any] = Bundle.main.infoDictionary ?? [:],
                               defaults: UserDefaults = .standard) -> WhatsNewAnnouncement? {
        let isFirstRun = defaults.object(forKey: lastVersionKey) == nil && defaults.object(forKey: acknowledgedRowsKey) == nil
        if let version = info["CFBundleShortVersionString"] as? String { defaults.set(version, forKey: lastVersionKey) }
        let announcement = installed(info: info)
        if isFirstRun {
            record(announcement?.rows ?? [], defaults: defaults)
            return nil
        }
        guard let announcement else { return nil }
        let acknowledged = Set(acknowledgedRowIDs(defaults: defaults))
        let unseen = announcement.rows.filter { !acknowledged.contains($0.id) }
        guard !unseen.isEmpty else { return nil }
        return WhatsNewAnnouncement(schemaVersion: announcement.schemaVersion, id: announcement.id,
                                    component: announcement.component, version: announcement.version,
                                    sourceCommit: announcement.sourceCommit, rows: unseen)
    }

    /// Whether every row of this announcement was already seen, at launch or from a Settings replay.
    public func isAcknowledged(defaults: UserDefaults = .standard) -> Bool {
        Set(rows.map(\.id)).isSubset(of: Self.acknowledgedRowIDs(defaults: defaults))
    }

    /// Records every row of this announcement as seen, so no later launch offers them again.
    public func acknowledge(defaults: UserDefaults = .standard) {
        Self.record(rows, defaults: defaults)
    }

    private static func acknowledgedRowIDs(defaults: UserDefaults) -> [String] {
        defaults.stringArray(forKey: acknowledgedRowsKey) ?? []
    }

    private static func record(_ rows: [Row], defaults: UserDefaults) {
        var acknowledged = acknowledgedRowIDs(defaults: defaults)
        for row in rows where !acknowledged.contains(row.id) { acknowledged.append(row.id) }
        defaults.set(acknowledged, forKey: acknowledgedRowsKey)
    }
}
