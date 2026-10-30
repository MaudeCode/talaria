import Foundation

/// The installed App release's What's New announcement (TAL-1616): display-ready rows that `scripts/stamp-release.py`
/// packages into the App's Info.plist as the exact JSON `app/ci/release_notes.py` generates, shaped by
/// `contracts/whats-new.schema.json`. It needs no server, so it reads offline and before sign-in.
public struct WhatsNewAnnouncement: Decodable, Equatable, Sendable {
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
}
