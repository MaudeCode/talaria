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
    static let sectionHost = "section"
    static let kanbanCardHost = "kanban-card"
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
    static let botChatHost = "bot-chat"

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

    /// A saved server and its profile. The canonical session is looked up when the link opens.
    public struct BotChat: Equatable, Sendable {
        public let profileName: String
        public let publisherID: String
    }

    public static func botChatURL(profileName: String, publisherID: String) -> URL? {
        let profile = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !profile.isEmpty, let publisher = normalizedPublisherID(publisherID) else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = botChatHost
        components.queryItems = [URLQueryItem(name: profileQueryItem, value: profile),
                                 URLQueryItem(name: "publisher", value: publisher)]
        return components.url
    }

    public static func botChat(from url: URL) -> BotChat? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == botChatHost,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let profile = items.first(where: { $0.name == profileQueryItem })?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines), !profile.isEmpty,
              let publisher = normalizedPublisherID(items.first { $0.name == "publisher" }?.value)
        else { return nil }
        return BotChat(profileName: profile, publisherID: publisher)
    }

    /// A destination opened from a transcript row or a Relay server notice.
    public enum Section: String, Sendable {
        case tasks, skills, tools, system
    }

    /// TAL-2326: `talaria://section?name=<section>`.
    public static func sectionURL(_ section: Section, publisherID: String? = nil) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = sectionHost
        components.queryItems = [URLQueryItem(name: "name", value: section.rawValue)]
        if let publisherID = normalizedPublisherID(publisherID) {
            components.queryItems?.append(URLQueryItem(name: "publisher", value: publisherID))
        }
        return components.url
    }

    public static func section(from url: URL) -> Section? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == sectionHost else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == "name" }?.value.flatMap(Section.init(rawValue:))
    }

    /// TAL-2327: `talaria://kanban-card?id=<card>&board=<slug>`, one Kanban card a transcript row opens on its board (the
    /// current board without one); nil for a blank card id.
    public static func kanbanCardURL(cardID: String, board: String? = nil) -> URL? {
        let id = cardID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = kanbanCardHost
        let board = board?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        components.queryItems = [URLQueryItem(name: "id", value: id)] + (board.isEmpty ? [] : [URLQueryItem(name: "board", value: board)])
        return components.url
    }

    /// TAL-2327: the card and board a `kanbanCardURL` link names; nil for any other link or a blank card id.
    public static func kanbanCard(from url: URL) -> (id: String, board: String?)? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == kanbanCardHost else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let id = value("id"), !id.isEmpty else { return nil }
        let board = value("board")
        return (id, board?.isEmpty == false ? board : nil)
    }

    static let addServerHost = "add-server"

    /// TAL-2623: the server an add-server link names and the sign-in Add Server opens prefilled with.
    public struct AddServer: Equatable, Identifiable, Sendable {
        public let url: String
        public let password: String
        public let name: String?
        public var id: String { url }
    }

    /// TAL-2623: `<scheme>://add-server?url=<http(s) URL>&password=<password>&name=<display name>`, which a phone test
    /// server prints; nil without an http(s) `url`.
    public static func addServer(from url: URL) -> AddServer? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == addServerHost else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard let server = value("url")?.trimmingCharacters(in: .whitespacesAndNewlines),
              let components = URLComponents(string: server),
              ["http", "https"].contains(components.scheme?.lowercased()),
              components.host?.isEmpty == false
        else { return nil }
        let name = value("name")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return AddServer(url: server, password: value("password") ?? "", name: name.isEmpty ? nil : name)
    }

    /// TAL-2623: whether this build opens add-server links; only Talaria Dev sets `APP_ACCEPTS_ADD_SERVER_LINKS`, so a
    /// password in a link never reaches App Store builds.
    public static var acceptsAddServerLinks: Bool {
        Bundle.main.object(forInfoDictionaryKey: "TalariaAcceptsAddServerLinks") as? String == "YES"
    }

    /// Whether a link is one of this build's own app links, which the app routes itself rather than the system.
    public static func isAppURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
    }

    /// TAL-1966: `reviewID` opens that decision review of the session's server rather than the chat.
    public static func sessionURL(sessionID: String, publisherID: String? = nil, reviewID: String? = nil) -> URL? {
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
        if let reviewID = normalizedDecisionReviewID(reviewID) {
            queryItems.append(URLQueryItem(name: "review", value: reviewID))
        }
        components.queryItems = queryItems
        return components.url
    }

    /// TAL-1966: the decision review a session link opens; nil for a plain chat link.
    public static func decisionReviewID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == sessionHost else { return nil }
        return normalizedDecisionReviewID(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "review" })?.value
        )
    }

    /// A review id as Talaria Web mints it (`dr_` and 8 lowercase hex digits), or the review of a `/decisions/<id>`
    /// Relay deep link; anything else is nil.
    public static func normalizedDecisionReviewID(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let id = raw.hasPrefix("/decisions/") ? String(raw.dropFirst("/decisions/".count)) : raw
        return id.wholeMatch(of: /dr_[0-9a-f]{8}/) == nil ? nil : id
    }

    public static func publisherID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == sessionHost || section(from: url) == .system
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
