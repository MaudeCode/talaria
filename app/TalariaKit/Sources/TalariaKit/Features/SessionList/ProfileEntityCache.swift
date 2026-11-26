import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Persists the last-known profile list to the app-group container so an App Intents query
/// (and #8's widgets, which run out-of-process) can populate their picker without a live,
/// authenticated server call. The app refreshes this on every foreground profiles load.
public struct ProfileEntityCache {
    public static var shared: ProfileEntityCache { ProfileEntityCache() }
    public static let widgetKind = "NewChatWidget"

    private let defaults: UserDefaults?
    // `.v2`: bumped from v1 when the App Shortcut refresh nudge was added, so the first load
    // on an upgraded install reads an empty cache and is treated as a change — which fires
    // `updateAppShortcutParameters()` once even though the profile list itself is unchanged.
    private let storageKey = "cachedProfileEntities.v2"

    public init(defaults: UserDefaults? = UserDefaults(suiteName: TalariaShareDraft.appGroupIdentifier)) {
        self.defaults = defaults
    }

    /// Mirrors the profiles into the cache: writes a compact snapshot when non-empty, clears
    /// the entry when empty so a stale list can't linger after the server reports none.
    /// Returns whether the stored snapshot actually changed, so the caller can avoid
    /// re-indexing App Shortcuts when nothing moved.
    @discardableResult
    public func save(_ profiles: [ProfileSummary], publisherID: String? = nil) -> Bool {
        guard let defaults else { return false }
        let snapshot = profiles.compactMap { CachedProfile($0, publisherID: publisherID) }
        if let publisherID {
            let botProfiles = snapshot.filter { $0.hasBotChat == true }
            let key = botProfilesKey(publisherID)
            if botProfiles != loadCached(key: key) {
                defaults.set(try? JSONEncoder().encode(botProfiles), forKey: key)
                saveBotChatAvatars(botChatAvatars(publisherID: publisherID), publisherID: publisherID)
                Self.reloadWidget()
            }
        }
        guard snapshot != loadCached() else { return false }

        if snapshot.isEmpty {
            defaults.removeObject(forKey: storageKey)
            return true
        }
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: storageKey)
        return true
    }

    /// The cached profiles, for the App Intents entity query.
    public func loadProfiles() -> [CachedProfile] {
        loadCached()
    }

    /// Widget configurations retain their server even when the app switches to a different one.
    public func loadBotChatProfiles(publisherID: String) -> [CachedProfile] {
        loadCached(key: botProfilesKey(publisherID))
    }

    public func botChatAvatars(publisherID: String) -> [String: Data] {
        defaults?.dictionary(forKey: botAvatarsKey(publisherID)) as? [String: Data] ?? [:]
    }

    func saveBotChatAvatars(_ images: [String: Data], publisherID: String) {
        guard let defaults else { return }
        let allowed = Set(loadBotChatProfiles(publisherID: publisherID).filter { $0.avatarPath != nil }.map(\.id))
        let current = images.filter { allowed.contains($0.key) }
        guard current != botChatAvatars(publisherID: publisherID) else { return }
        defaults.set(current.isEmpty ? nil : current, forKey: botAvatarsKey(publisherID))
        Self.reloadWidget()
    }

    func clearBotChatProfiles(publisherID: String) {
        guard let defaults else { return }
        defaults.removeObject(forKey: botProfilesKey(publisherID))
        defaults.removeObject(forKey: botAvatarsKey(publisherID))
        Self.reloadWidget()
    }

    private func botProfilesKey(_ publisherID: String) -> String { "cachedBotChatProfiles.v1.\(publisherID)" }
    private func botAvatarsKey(_ publisherID: String) -> String { "cachedBotChatAvatars.v1.\(publisherID)" }

    private static func reloadWidget() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        #endif
    }

    private func loadCached(key: String? = nil) -> [CachedProfile] {
        guard let defaults,
              let data = defaults.data(forKey: key ?? storageKey),
              let cached = try? JSONDecoder().decode([CachedProfile].self, from: data)
        else {
            return []
        }
        return cached
    }
}

/// Minimal codable snapshot of a profile for the cache — deliberately decoupled from the
/// server model so an upstream shape change can't break a cached read.
public struct CachedProfile: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let subtitle: String?
    public let publisherID: String?
    public let hasBotChat: Bool?
    let avatarPath: String?

    /// Skips a profile with no usable name (the name is the load-bearing identifier for
    /// routing and session creation).
    public init?(_ summary: ProfileSummary, publisherID: String? = nil) {
        guard let id = summary.normalizedName else { return nil }
        self.id = id
        self.name = summary.displayName
        self.subtitle = Self.subtitle(for: summary)
        self.publisherID = publisherID
        self.hasBotChat = summary.canonicalSession != nil
        self.avatarPath = summary.botChatAvatarPath
    }

    private static func subtitle(for summary: ProfileSummary) -> String? {
        let parts = [summary.model, summary.provider]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
