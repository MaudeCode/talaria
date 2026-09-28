import Foundation

/// Persists the last-known profile list to the app-group container so an App Intents query
/// (and #8's widgets, which run out-of-process) can populate their picker without a live,
/// authenticated server call. The app refreshes this on every foreground profiles load.
public struct ProfileEntityCache {
    public static let shared = ProfileEntityCache()

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
    public func save(_ profiles: [ProfileSummary]) -> Bool {
        guard let defaults else { return false }
        let snapshot = profiles.compactMap(CachedProfile.init)
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

    private func loadCached() -> [CachedProfile] {
        guard let defaults,
              let data = defaults.data(forKey: storageKey),
              let cached = try? JSONDecoder().decode([CachedProfile].self, from: data)
        else {
            return []
        }
        return cached
    }
}

/// Minimal codable snapshot of a profile for the cache — deliberately decoupled from the
/// server model so an upstream shape change can't break a cached read.
public struct CachedProfile: Codable, Equatable {
    public let id: String
    public let name: String
    public let subtitle: String?

    /// Skips a profile with no usable name (the name is the load-bearing identifier for
    /// routing and session creation).
    public init?(_ summary: ProfileSummary) {
        guard let id = summary.normalizedName else { return nil }
        self.id = id
        self.name = summary.displayName
        self.subtitle = Self.subtitle(for: summary)
    }

    private static func subtitle(for summary: ProfileSummary) -> String? {
        let parts = [summary.model, summary.provider]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
