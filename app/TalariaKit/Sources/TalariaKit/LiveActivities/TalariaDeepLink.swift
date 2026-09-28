import Foundation

public enum ProviderQuotaWidgetLaunchAction {
    public static let pendingRefreshSourceKey = "providerQuota.pendingRefreshSource"
}

public enum TalariaDeepLink {
    static var scheme: String {
        Bundle.main.object(forInfoDictionaryKey: "TalariaURLScheme") as? String
            ?? "talaria"
    }

    static let sessionHost = "session"
    static let quotaSourceHost = "quota-source"
    static let quotaSourceQueryItem = "source"
    static let quotaRefreshQueryItem = "refresh"
    static let providerQuotaWidgetSettingsHost = "provider-quota-widget-settings"
    static let openAppHost = "open"
    static let newChatProviderHost = "new-chat-provider"
    static let providerQueryItem = "provider"

    public static func quotaSourceURL(sourceID: String, refresh: Bool = false) -> URL? {
        let trimmed = sourceID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var components = URLComponents()
        components.scheme = scheme
        components.host = quotaSourceHost
        components.queryItems = [URLQueryItem(name: quotaSourceQueryItem, value: trimmed)]
        if refresh {
            components.queryItems?.append(URLQueryItem(name: quotaRefreshQueryItem, value: "1"))
        }
        return components.url
    }

    public static var providerQuotaWidgetSettingsURL: URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = providerQuotaWidgetSettingsHost
        return components.url
    }

    public static func isProviderQuotaWidgetSettingsURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host?.lowercased() == providerQuotaWidgetSettingsHost
    }

    public static func requestsQuotaRefresh(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == quotaSourceHost
        else { return false }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .contains(where: { $0.name == quotaRefreshQueryItem && $0.value == "1" }) == true
    }

    public static var openAppURL: URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = openAppHost
        return components.url
    }

    public static func isOpenAppURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host?.lowercased() == openAppHost
    }

    public static func newChatWithProviderURL(providerID: String) -> URL? {
        let providerID = providerID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !providerID.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = newChatProviderHost
        components.queryItems = [URLQueryItem(name: providerQueryItem, value: providerID)]
        return components.url
    }

    public static func providerID(fromNewChatWithProvider url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == newChatProviderHost
        else { return nil }
        let providerID = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == providerQueryItem })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return providerID?.isEmpty == false ? providerID : nil
    }

    public static func quotaSourceID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == quotaSourceHost,
              let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == quotaSourceQueryItem })?
                .value
        else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Host for the parameter-less "open the New Chat composer" deep link used by the
    /// New Chat App Intent (issue #337). Mirrors the share extension's host-based routing
    /// so the intent can reuse `ContentView.handleOpenURL` rather than inventing a new path.
    static let newChatHost = "new-chat"

    /// `talaria://new-chat` (scheme follows the active build, e.g. `-branch`).
    public static var newChatURL: URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = newChatHost
        return components.url
    }

    public static func isNewChatURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host?.lowercased() == newChatHost
    }

    /// Host for "open the New Chat composer *and* auto-start voice dictation", used by the
    /// "New Chat with Voice" App Intent (issue #338). A distinct host from `newChatHost`
    /// so the two intents never alias each other — `isNewChatURL` and `isNewChatVoiceURL`
    /// are mutually exclusive.
    static let newChatVoiceHost = "new-chat-voice"

    /// `talaria://new-chat-voice` (scheme follows the active build, e.g. `-branch`).
    public static var newChatVoiceURL: URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = newChatVoiceHost
        return components.url
    }

    public static func isNewChatVoiceURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host?.lowercased() == newChatVoiceHost
    }

    /// Host for "open the New Chat composer pinned to a specific profile", used by the
    /// "New Chat in <Profile>" App Intent (issue #339). A distinct host from the other
    /// new-chat hosts so the three intents never alias; the profile name rides as a query
    /// item (like `sessionURL`'s `id`) rather than in the host, so it can carry spaces and
    /// non-ASCII safely via percent-encoding.
    static let newChatInProfileHost = "new-chat-profile"

    /// Query-item name carrying the profile's server name.
    static let profileQueryItem = "profile"

    /// `talaria://new-chat-profile?profile=<name>` (scheme follows the active build).
    /// Returns nil for a blank profile name so callers can pass it straight through.
    public static func newChatInProfileURL(profileName: String) -> URL? {
        let trimmed = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var components = URLComponents()
        components.scheme = scheme
        components.host = newChatInProfileHost
        components.queryItems = [URLQueryItem(name: profileQueryItem, value: trimmed)]
        return components.url
    }

    public static func isNewChatInProfileURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host?.lowercased() == newChatInProfileHost
    }

    /// Extracts the profile name from a "New Chat in <Profile>" URL, or nil when the URL is a
    /// different kind or carries no (non-blank) profile.
    public static func profileName(fromNewChatInProfile url: URL) -> String? {
        guard isNewChatInProfileURL(url) else { return nil }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        guard let raw = components?.queryItems?.first(where: { $0.name == profileQueryItem })?.value
        else {
            return nil
        }

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public static func sessionURL(sessionID: String, publisherID: String? = nil) -> URL? {
        guard !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        var components = URLComponents()
        components.scheme = scheme
        components.host = sessionHost
        var queryItems = [
            URLQueryItem(name: "id", value: sessionID)
        ]
        if let publisherID = normalizedPublisherID(publisherID) {
            queryItems.append(URLQueryItem(name: "publisher", value: publisherID))
        }
        components.queryItems = queryItems
        return components.url
    }

    public static func publisherID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == sessionHost
        else { return nil }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        return normalizedPublisherID(
            components?.queryItems?.first(where: { $0.name == "publisher" })?.value
        )
    }

    public static func sessionID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == sessionHost
        else {
            return nil
        }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let id = components?.queryItems?.first(where: { item in
            item.name == "id" || item.name == "session_id"
        })?.value {
            return normalizedSessionID(id)
        }

        let pathID = url.pathComponents
            .filter { $0 != "/" }
            .first
        return normalizedSessionID(pathID)
    }

    private static func normalizedSessionID(_ rawValue: String?) -> String? {
        let trimmed = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizedPublisherID(_ rawValue: String?) -> String? {
        let trimmed = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
