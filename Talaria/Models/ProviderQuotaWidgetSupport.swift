import AppIntents
import Foundation
import Security
import SwiftUI
import WidgetKit

struct ProviderQuotaWidgetSource: Codable, Equatable, Identifiable, Sendable {
    var id: String { sourceID }
    var freshnessDate: Date { ProviderQuotaDateParser.date(from: fetchedAt) ?? cachedAt }

    let sourceID: String
    let scopeID: String
    let scopeLabel: String
    let cachedAt: Date
    let providerID: String?
    let providerLabel: String
    let accountLabel: String
    let isActiveProvider: Bool
    let status: String
    let plan: String?
    let windows: [ProviderQuotaWindow]
    let quota: ProviderQuotaAmount?
    let retryAfter: String?
    let fetchedAt: String?

    init(
        sourceID: String,
        scopeID: String = "qscope_default",
        scopeLabel: String = "Default",
        cachedAt: Date = Date(),
        providerID: String? = nil,
        providerLabel: String,
        accountLabel: String,
        isActiveProvider: Bool,
        status: String,
        plan: String?,
        windows: [ProviderQuotaWindow],
        quota: ProviderQuotaAmount? = nil,
        retryAfter: String?,
        fetchedAt: String?
    ) {
        self.sourceID = sourceID
        self.scopeID = scopeID
        self.scopeLabel = scopeLabel
        self.cachedAt = cachedAt
        self.providerID = providerID
        self.providerLabel = providerLabel
        self.accountLabel = accountLabel
        self.isActiveProvider = isActiveProvider
        self.status = status
        self.plan = plan
        self.windows = windows
        self.quota = quota
        self.retryAfter = retryAfter
        self.fetchedAt = fetchedAt
    }

    init(_ source: ProviderQuotaSource, scopeID: String, scopeLabel: String) {
        self.init(
            sourceID: source.id,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            providerID: source.providerID,
            providerLabel: source.providerLabel,
            accountLabel: source.accountLabel,
            isActiveProvider: source.isActiveProvider,
            status: source.status,
            plan: source.plan,
            windows: source.windows,
            quota: source.quota,
            retryAfter: source.retryAfter,
            fetchedAt: source.fetchedAt
        )
    }

    func withCachedAt(_ cachedAt: Date) -> ProviderQuotaWidgetSource {
        ProviderQuotaWidgetSource(
            sourceID: sourceID,
            scopeID: scopeID,
            scopeLabel: scopeLabel,
            cachedAt: cachedAt,
            providerID: providerID,
            providerLabel: providerLabel,
            accountLabel: accountLabel,
            isActiveProvider: isActiveProvider,
            status: status,
            plan: plan,
            windows: windows,
            quota: quota,
            retryAfter: retryAfter,
            fetchedAt: fetchedAt
        )
    }
}

struct ProviderQuotaWidgetSnapshot: Codable, Equatable, Sendable {
    static let staleAfter: TimeInterval = 15 * 60

    let updatedAt: Date
    let sources: [ProviderQuotaWidgetSource]

    func isStale(at date: Date = Date(), maximumAge: TimeInterval = staleAfter) -> Bool {
        date.timeIntervalSince(updatedAt) > maximumAge
    }
}

struct ProviderQuotaWidgetSnapshotStore {
    static let widgetKind = "ProviderQuotaWidget"
    static let storageKey = "providerQuotaWidgetSnapshot.v1"

    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = UserDefaults(suiteName: Self.appGroupIdentifier)) {
        self.defaults = defaults
    }

    @discardableResult
    func save(
        scopeID: String,
        sources: [ProviderQuotaWidgetSource],
        updatedSourceIDs: Set<String>? = nil,
        at date: Date = Date()
    ) -> Bool {
        guard sources.allSatisfy({ $0.scopeID == scopeID }) else { return false }
        let previous = Dictionary(uniqueKeysWithValues: (load()?.sources ?? []).map { ($0.sourceID, $0) })
        let persistedSources = sources.map { source in
            guard let updatedSourceIDs,
                  !updatedSourceIDs.contains(source.sourceID),
                  let previous = previous[source.sourceID]
            else {
                return source
            }
            return source.withCachedAt(previous.cachedAt)
        }
        guard let defaults,
              let data = try? JSONEncoder().encode(
                ProviderQuotaWidgetSnapshot(updatedAt: date, sources: persistedSources)
              )
        else {
            return false
        }
        defaults.set(data, forKey: Self.storageKey)
        return true
    }

    func load() -> ProviderQuotaWidgetSnapshot? {
        guard let data = defaults?.data(forKey: Self.storageKey) else { return nil }
        return try? JSONDecoder().decode(ProviderQuotaWidgetSnapshot.self, from: data)
    }

    @discardableResult
    func clear() -> Bool {
        guard let defaults, defaults.object(forKey: Self.storageKey) != nil else { return false }
        defaults.removeObject(forKey: Self.storageKey)
        return true
    }

    static var appGroupIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "TalariaAppGroupIdentifier") as? String
            ?? "group.dev.kil.talaria"
    }

    static var appGroupDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }
}

enum ProviderQuotaRefreshInterval: Int, CaseIterable, Identifiable {
    case oneMinute = 60
    case fiveMinutes = 300
    case fifteenMinutes = 900
    case thirtyMinutes = 1_800

    static let storageKey = "providerQuota.refreshIntervalSeconds"
    static let defaultValue = ProviderQuotaRefreshInterval.fiveMinutes

    var id: Int { rawValue }
    var duration: Duration { .seconds(rawValue) }

    var title: String {
        switch self {
        case .oneMinute: String(localized: "Every minute")
        case .fiveMinutes: String(localized: "Every 5 minutes")
        case .fifteenMinutes: String(localized: "Every 15 minutes")
        case .thirtyMinutes: String(localized: "Every 30 minutes")
        }
    }

    static func storedValue(_ rawValue: Int) -> ProviderQuotaRefreshInterval {
        ProviderQuotaRefreshInterval(rawValue: rawValue) ?? defaultValue
    }
}

struct ProviderQuotaWidgetRefreshHeader: Codable, Equatable, Sendable {
    let name: String
    let value: String
}

struct ProviderQuotaWidgetRefreshCookie: Codable, Equatable, Sendable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let isSecure: Bool
    let expiresDate: Date?

    init(_ cookie: HTTPCookie) {
        name = cookie.name
        value = cookie.value
        domain = cookie.domain
        path = cookie.path
        isSecure = cookie.isSecure
        expiresDate = cookie.expiresDate
    }

    var httpCookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
            .secure: isSecure ? "TRUE" : "FALSE",
        ]
        if let expiresDate {
            properties[.expires] = expiresDate
        }
        return HTTPCookie(properties: properties)
    }

    var identity: String { "\(name)|\(domain)|\(path)" }
}

struct ProviderQuotaWidgetRefreshCredentials: Codable, Equatable, Sendable {
    let serverURLString: String
    let serverLabel: String
    let refreshIntervalSeconds: Int
    let headers: [ProviderQuotaWidgetRefreshHeader]
    let cookies: [ProviderQuotaWidgetRefreshCookie]

    var serverURL: URL? { URL(string: serverURLString) }

    func merging(responseCookies: [HTTPCookie]) -> ProviderQuotaWidgetRefreshCredentials {
        guard !responseCookies.isEmpty else { return self }
        var merged = Dictionary(uniqueKeysWithValues: cookies.map { ($0.identity, $0) })
        for cookie in responseCookies {
            let stored = ProviderQuotaWidgetRefreshCookie(cookie)
            merged[stored.identity] = stored
        }
        return ProviderQuotaWidgetRefreshCredentials(
            serverURLString: serverURLString,
            serverLabel: serverLabel,
            refreshIntervalSeconds: refreshIntervalSeconds,
            headers: headers,
            cookies: Array(merged.values)
        )
    }
}

enum ProviderQuotaWidgetRefreshCredentialStore {
    private static let account = "active-provider-quota-refresh.v1"

    static func load() -> ProviderQuotaWidgetRefreshCredentials? {
        guard var query = baseQuery else { return nil }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(ProviderQuotaWidgetRefreshCredentials.self, from: data)
    }

    @discardableResult
    static func save(_ credentials: ProviderQuotaWidgetRefreshCredentials) -> Bool {
        guard let data = try? JSONEncoder().encode(credentials), let baseQuery else { return false }
        let attributes = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var item = baseQuery
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    static func clear() -> Bool {
        guard let baseQuery else { return false }
        let status = SecItemDelete(baseQuery as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static var baseQuery: [String: Any]? {
        guard let accessGroup = sharedAccessGroup else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: sharedService,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }

    private static var sharedService: String {
        Bundle.main.object(forInfoDictionaryKey: "TalariaSharedKeychainService") as? String
            ?? "dev.kil.talaria.providerQuotaRefresh"
    }

    private static var sharedAccessGroup: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "TalariaSharedKeychainAccessGroup") as? String,
              !value.isEmpty,
              !value.contains("$(")
        else { return nil }
        return value
    }
}

enum ProviderQuotaWidgetRefreshClient {
    static func refreshFromSharedCredentials() async -> Bool {
        guard let credentials = ProviderQuotaWidgetRefreshCredentialStore.load() else { return false }
        return await refresh(credentials: credentials)
    }

    static func refresh(credentials: ProviderQuotaWidgetRefreshCredentials) async -> Bool {
        guard let baseURL = credentials.serverURL,
              let url = refreshURL(relativeTo: baseURL)
        else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        for header in credentials.headers {
            request.setValue(header.value, forHTTPHeaderField: header.name)
        }
        let liveCookies = credentials.cookies
            .filter { $0.expiresDate.map { $0 > Date() } ?? true }
            .compactMap(\.httpCookie)
        if let cookie = HTTPCookie.requestHeaderFields(with: liveCookies)["Cookie"] {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let delegate = ProviderQuotaWidgetRedirectDelegate(baseURL: baseURL)
        let session = URLSession(
            configuration: .ephemeral,
            delegate: delegate,
            delegateQueue: nil
        )
        defer { session.finishTasksAndInvalidate() }

        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let quotaResponse = try? JSONDecoder().decode(ProviderQuotasResponse.self, from: data),
                  quotaResponse.version == 1,
                  let scopeID = quotaResponse.scopeID,
                  !scopeID.isEmpty
            else { return false }

            persistResponseCookies(from: httpResponse, url: url, credentials: credentials)
            let profileID = quotaResponse.profileID ?? "default"
            let sources = quotaResponse.sources.map {
                ProviderQuotaWidgetSource(
                    $0,
                    scopeID: scopeID,
                    scopeLabel: "\(credentials.serverLabel) · \(profileID)"
                )
            }
            guard ProviderQuotaWidgetSnapshotStore().save(scopeID: scopeID, sources: sources) else {
                return false
            }
            WidgetCenter.shared.reloadTimelines(ofKind: ProviderQuotaWidgetSnapshotStore.widgetKind)
            return true
        } catch {
            return false
        }
    }

    private static func refreshURL(relativeTo baseURL: URL) -> URL? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "/api/provider/quotas"),
            resolvingAgainstBaseURL: false
        ) else { return nil }
        components.queryItems = [URLQueryItem(name: "refresh", value: "1")]
        return components.url
    }

    private static func persistResponseCookies(
        from response: HTTPURLResponse,
        url: URL,
        credentials: ProviderQuotaWidgetRefreshCredentials
    ) {
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String, let value = entry.value as? String else { return }
            result[key] = value
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
        guard !cookies.isEmpty else { return }
        _ = ProviderQuotaWidgetRefreshCredentialStore.save(credentials.merging(responseCookies: cookies))
    }
}

private final class ProviderQuotaWidgetRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let destination = request.url,
              destination.scheme?.lowercased() == baseURL.scheme?.lowercased(),
              destination.host?.lowercased() == baseURL.host?.lowercased(),
              normalizedPort(for: destination) == normalizedPort(for: baseURL)
        else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    private func normalizedPort(for url: URL) -> Int? {
        if let port = url.port { return port }
        return switch url.scheme?.lowercased() {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
}

enum ProviderQuotaPercentageMode: String, CaseIterable, Identifiable {
    case used
    case remaining

    static let storageKey = "providerQuota.percentageMode"
    static let defaultValue = ProviderQuotaPercentageMode.used

    var id: String { rawValue }
    var title: String {
        switch self {
        case .used: String(localized: "Used")
        case .remaining: String(localized: "Remaining")
        }
    }
}

enum ProviderQuotaWidgetArcColor: String, CaseIterable, Identifiable {
    case automatic
    case accent
    case blue
    case cyan
    case green
    case indigo
    case mint
    case orange
    case pink
    case purple
    case red
    case teal
    case yellow
    case brown
    case gray
    case custom

    static let storageKey = "providerQuota.widgetArcColor"
    static let defaultValue = ProviderQuotaWidgetArcColor.automatic

    var id: String { rawValue }
    var title: String {
        switch self {
        case .automatic: String(localized: "Automatic")
        case .accent: String(localized: "Accent")
        case .blue: String(localized: "Blue")
        case .cyan: String(localized: "Cyan")
        case .green: String(localized: "Green")
        case .indigo: String(localized: "Indigo")
        case .mint: String(localized: "Mint")
        case .orange: String(localized: "Orange")
        case .pink: String(localized: "Pink")
        case .purple: String(localized: "Purple")
        case .red: String(localized: "Red")
        case .teal: String(localized: "Teal")
        case .yellow: String(localized: "Yellow")
        case .brown: String(localized: "Brown")
        case .gray: String(localized: "Gray")
        case .custom: String(localized: "Custom")
        }
    }
}

enum ProviderQuotaWidgetArcWeight: String, CaseIterable, Identifiable {
    case thin
    case regular
    case bold

    static let storageKey = "providerQuota.widgetArcWeight"
    static let defaultValue = ProviderQuotaWidgetArcWeight.regular

    var id: String { rawValue }
    var title: String {
        switch self {
        case .thin: String(localized: "Thin")
        case .regular: String(localized: "Regular")
        case .bold: String(localized: "Bold")
        }
    }
}

enum ProviderQuotaWidgetColorBasis: String, CaseIterable, Identifiable {
    case pace
    case overall

    static let storageKey = "providerQuota.widgetColorBasis"
    static let defaultValue = ProviderQuotaWidgetColorBasis.pace

    var id: String { rawValue }
    var title: String {
        switch self {
        case .pace: String(localized: "Pace")
        case .overall: String(localized: "Overall Percentage")
        }
    }
}

enum ProviderQuotaWidgetWindowSelection: String, AppEnum {
    case automatic
    case session
    case weekly

    static let storageKey = "providerQuota.widgetWindowSelection"
    static let defaultValue = ProviderQuotaWidgetWindowSelection.automatic

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota Window")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .automatic: "Automatic",
        .session: "Session",
        .weekly: "Weekly",
    ]
}

enum ProviderQuotaWidgetStatusText: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case percentage
    case pace
    case hidden

    static let storageKey = "providerQuota.widgetStatusText"
    static let defaultValue = ProviderQuotaWidgetStatusText.percentage
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Status Text")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .percentage: "Used or Remaining",
        .pace: "Pace",
        .hidden: "Hidden",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .percentage: String(localized: "Used or Remaining")
        case .pace: String(localized: "Pace")
        case .hidden: String(localized: "Hidden")
        }
    }
}

enum ProviderQuotaWidgetResetDisplay: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case hidden
    case compact
    case exact

    static let storageKey = "providerQuota.widgetResetDisplay"
    static let defaultValue = ProviderQuotaWidgetResetDisplay.compact
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Reset Display")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .hidden: "Hidden",
        .compact: "Compact Countdown",
        .exact: "Date and Time",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .hidden: String(localized: "Hidden")
        case .compact: String(localized: "Compact Countdown")
        case .exact: String(localized: "Date and Time")
        }
    }
}

enum ProviderQuotaWidgetTapAction: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case insights
    case settings
    case refresh
    case openApp
    case newChatWithProvider

    static let storageKey = "providerQuota.widgetTapAction"
    static let defaultValue = ProviderQuotaWidgetTapAction.insights
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Tap Action")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .insights: "Open Insights",
        .settings: "Open Widget Settings",
        .refresh: "Refresh in Talaria",
        .openApp: "Open Talaria",
        .newChatWithProvider: "New Chat with Provider",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .insights: String(localized: "Open Insights")
        case .settings: String(localized: "Open Widget Settings")
        case .refresh: String(localized: "Refresh in Talaria")
        case .openApp: String(localized: "Open Talaria")
        case .newChatWithProvider: String(localized: "New Chat with Provider")
        }
    }
}

enum ProviderQuotaWidgetBackground: String, AppEnum, CaseIterable, Identifiable {
    case appDefault
    case system
    case clear
    case tinted
    case dark
    case light
    case custom

    static let storageKey = "providerQuota.widgetBackground"
    static let customColorHexKey = "providerQuota.widgetCustomBackgroundColorHex"
    static let opacityPercentKey = "providerQuota.widgetBackgroundOpacityPercent"
    static let defaultValue = ProviderQuotaWidgetBackground.system
    static let defaultCustomColorHex = "#1C1C1E"
    static let defaultOpacityPercent = 100
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Background")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .system: "System",
        .clear: "Transparent",
        .tinted: "Accent Tint",
        .dark: "Dark",
        .light: "Light",
        .custom: "Custom",
    ]

    var id: String { rawValue }
    var title: String {
        switch self {
        case .appDefault: String(localized: "App Default")
        case .system: String(localized: "System")
        case .clear: String(localized: "Transparent")
        case .tinted: String(localized: "Accent Tint")
        case .dark: String(localized: "Dark")
        case .light: String(localized: "Light")
        case .custom: String(localized: "Custom")
        }
    }
}

enum ProviderQuotaWidgetColorOverride: String, AppEnum {
    case appDefault
    case automatic
    case accent
    case blue
    case cyan
    case green
    case indigo
    case mint
    case orange
    case pink
    case purple
    case red
    case teal
    case yellow
    case brown
    case gray
    case custom

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Gauge Color")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .automatic: "Automatic",
        .accent: "Accent",
        .blue: "Blue",
        .cyan: "Cyan",
        .green: "Green",
        .indigo: "Indigo",
        .mint: "Mint",
        .orange: "Orange",
        .pink: "Pink",
        .purple: "Purple",
        .red: "Red",
        .teal: "Teal",
        .yellow: "Yellow",
        .brown: "Brown",
        .gray: "Gray",
        .custom: "Custom",
    ]

    func resolved(default value: ProviderQuotaWidgetArcColor) -> ProviderQuotaWidgetArcColor {
        self == .appDefault ? value : ProviderQuotaWidgetArcColor(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetWeightOverride: String, AppEnum {
    case appDefault
    case thin
    case regular
    case bold

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Gauge Weight")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .thin: "Thin",
        .regular: "Regular",
        .bold: "Bold",
    ]

    func resolved(default value: ProviderQuotaWidgetArcWeight) -> ProviderQuotaWidgetArcWeight {
        self == .appDefault ? value : ProviderQuotaWidgetArcWeight(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetBasisOverride: String, AppEnum {
    case appDefault
    case pace
    case overall

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Color Basis")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .pace: "Pace",
        .overall: "Overall Percentage",
    ]

    func resolved(default value: ProviderQuotaWidgetColorBasis) -> ProviderQuotaWidgetColorBasis {
        self == .appDefault ? value : ProviderQuotaWidgetColorBasis(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetPercentageOverride: String, AppEnum {
    case appDefault
    case used
    case remaining

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Percentage")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .used: "Used",
        .remaining: "Remaining",
    ]

    func resolved(default value: ProviderQuotaPercentageMode) -> ProviderQuotaPercentageMode {
        self == .appDefault ? value : ProviderQuotaPercentageMode(rawValue: rawValue) ?? value
    }
}

enum ProviderQuotaWidgetPaceMarkerOverride: String, AppEnum {
    case appDefault
    case shown
    case hidden

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Pace Marker")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .shown: "Shown",
        .hidden: "Hidden",
    ]

    func resolved(default value: Bool) -> Bool {
        switch self {
        case .appDefault: value
        case .shown: true
        case .hidden: false
        }
    }
}

enum ProviderQuotaWidgetAppearanceSettings {
    static let showsProviderIconKey = "providerQuota.widgetShowsProviderIcon"
    static let providerIconStyleKey = "providerQuota.widgetProviderIconStyle"
    static let healthyColorKey = "providerQuota.widgetHealthyColor"
    static let warningColorKey = "providerQuota.widgetWarningColor"
    static let criticalColorKey = "providerQuota.widgetCriticalColor"
    static let staleColorKey = "providerQuota.widgetStaleColor"
    static let unavailableColorKey = "providerQuota.widgetUnavailableColor"
    static let warningRemainingPercentKey = "providerQuota.widgetWarningRemainingPercent"
    static let criticalRemainingPercentKey = "providerQuota.widgetCriticalRemainingPercent"
    static let paceTolerancePercentKey = "providerQuota.widgetPaceTolerancePercent"
    static let paceWarningBurnRatePercentKey = "providerQuota.widgetPaceWarningBurnRatePercent"
    static let paceCriticalBurnRatePercentKey = "providerQuota.widgetPaceCriticalBurnRatePercent"
    static let paceMinimumElapsedHoursKey = "providerQuota.widgetPaceMinimumElapsedHours"
    static let showsPaceMarkerKey = "providerQuota.widgetShowsPaceMarker"
    static let trackColorKey = "providerQuota.widgetTrackColor"
    static let trackOpacityPercentKey = "providerQuota.widgetTrackOpacityPercent"
    static let customArcColorHexKey = "providerQuota.widgetCustomArcColorHex"
    static let customTrackColorHexKey = "providerQuota.widgetCustomTrackColorHex"
    static let customHealthyColorHexKey = "providerQuota.widgetCustomHealthyColorHex"
    static let customWarningColorHexKey = "providerQuota.widgetCustomWarningColorHex"
    static let customCriticalColorHexKey = "providerQuota.widgetCustomCriticalColorHex"
    static let customStaleColorHexKey = "providerQuota.widgetCustomStaleColorHex"
    static let customUnavailableColorHexKey = "providerQuota.widgetCustomUnavailableColorHex"

    static let defaultShowsProviderIcon = true
    static let defaultProviderIconStyle = ProviderIconStyle.color
    static let defaultHealthyColor = ProviderQuotaWidgetArcColor.accent
    static let defaultWarningColor = ProviderQuotaWidgetArcColor.orange
    static let defaultCriticalColor = ProviderQuotaWidgetArcColor.red
    static let defaultStaleColor = ProviderQuotaWidgetArcColor.orange
    static let defaultUnavailableColor = ProviderQuotaWidgetArcColor.orange
    static let defaultWarningRemainingPercent = 25
    static let defaultCriticalRemainingPercent = 10
    static let defaultPaceTolerancePercent = 3
    static let defaultPaceWarningBurnRatePercent = 125
    static let defaultPaceCriticalBurnRatePercent = 175
    static let defaultPaceMinimumElapsedHours = 12
    static let defaultShowsPaceMarker = true
    static let defaultTrackColor = ProviderQuotaWidgetArcColor.automatic
    static let defaultTrackOpacityPercent = 18
    static let defaultCustomArcColorHex = "#0A84FF"
    static let defaultCustomTrackColorHex = "#8E8E93"
    static let defaultCustomHealthyColorHex = "#0A84FF"
    static let defaultCustomWarningColorHex = "#FF9F0A"
    static let defaultCustomCriticalColorHex = "#FF453A"
    static let defaultCustomStaleColorHex = "#8E8E93"
    static let defaultCustomUnavailableColorHex = "#8E8E93"
}

enum ProviderQuotaAlertSettings {
    static let isEnabledKey = "providerQuota.alertsEnabled"
    static let stateKey = "providerQuota.alertStates"
}

struct ProviderQuotaEvaluationSettings: Equatable {
    let percentageMode: ProviderQuotaPercentageMode
    let colorBasis: ProviderQuotaWidgetColorBasis
    let windowSelection: ProviderQuotaWidgetWindowSelection
    let warningRemainingPercent: Int
    let criticalRemainingPercent: Int
    let paceTolerancePercent: Int
    let paceWarningBurnRatePercent: Int
    let paceCriticalBurnRatePercent: Int
    let paceMinimumElapsedHours: Int

    static func stored(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults,
        configuration: ProviderQuotaWidgetConfigurationIntent? = nil,
        profileID: String? = nil,
        followsSelectedDefault: Bool = true
    ) -> ProviderQuotaEvaluationSettings {
        let profile = ProviderQuotaWidgetResolvedProfile.resolve(
            id: profileID ?? configuration?.profile?.id,
            followsSelectedDefault: followsSelectedDefault,
            defaults: defaults
        )
        let defaultPercentage = ProviderQuotaPercentageMode(
            rawValue: profile.string(ProviderQuotaPercentageMode.storageKey)
        ) ?? .defaultValue
        let defaultBasis = ProviderQuotaWidgetColorBasis(
            rawValue: profile.string(ProviderQuotaWidgetColorBasis.storageKey)
        ) ?? .defaultValue
        let usesSavedProfile = profile.id != ProviderQuotaWidgetProfileStore.defaultProfileID
        return ProviderQuotaEvaluationSettings(
            percentageMode: usesSavedProfile ? defaultPercentage : configuration?.percentageMode.resolved(default: defaultPercentage) ?? defaultPercentage,
            colorBasis: usesSavedProfile ? defaultBasis : configuration?.colorBasis.resolved(default: defaultBasis) ?? defaultBasis,
            windowSelection: usesSavedProfile
                ? ProviderQuotaWidgetWindowSelection(rawValue: profile.string(ProviderQuotaWidgetWindowSelection.storageKey)) ?? .defaultValue
                : configuration?.windowSelection ?? .defaultValue,
            warningRemainingPercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey),
            criticalRemainingPercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey),
            paceTolerancePercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey),
            paceWarningBurnRatePercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey),
            paceCriticalBurnRatePercent: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey),
            paceMinimumElapsedHours: profile.integer(ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey)
        )
    }
}

enum ProviderQuotaUrgency: Equatable {
    case healthy
    case warning
    case critical
    case stale
    case unavailable
}

struct ProviderQuotaPace: Equatable {
    let expectedRemainingPercent: Double
    let paceDeltaPercent: Double
    let burnRate: Double
    let minutesToReset: Double
    let projectedMinutesToEmpty: Double?
    let projectionEligible: Bool
}

struct ProviderQuotaPresentationState: Equatable {
    let window: ProviderQuotaWindow?
    let percent: Double?
    let remainingPercent: Double?
    let resetAt: Date?
    let referenceDate: Date
    let freshnessDate: Date
    let isStale: Bool
    let pace: ProviderQuotaPace?
    let urgency: ProviderQuotaUrgency
    let settings: ProviderQuotaEvaluationSettings

    var expectedPercent: Double? {
        guard let expectedRemaining = pace?.expectedRemainingPercent else { return nil }
        return settings.percentageMode == .used ? 100 - expectedRemaining : expectedRemaining
    }

    var modeLabel: String {
        settings.percentageMode == .used ? String(localized: "used") : String(localized: "remaining")
    }

    var paceLabel: String? {
        guard let delta = pace?.paceDeltaPercent else { return nil }
        let value = abs(delta).formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        if delta <= -Double(max(0, settings.paceTolerancePercent)) {
            return String(localized: "\(value) over pace")
        }
        if delta > 1 { return String(localized: "\(value) under pace") }
        return String(localized: "On pace")
    }

    func withUrgency(_ urgency: ProviderQuotaUrgency) -> ProviderQuotaPresentationState {
        ProviderQuotaPresentationState(
            window: window,
            percent: percent,
            remainingPercent: remainingPercent,
            resetAt: resetAt,
            referenceDate: referenceDate,
            freshnessDate: freshnessDate,
            isStale: urgency == .stale || isStale,
            pace: pace,
            urgency: urgency,
            settings: settings
        )
    }
}

struct ProviderQuotaGaugeStyle {
    let arcColor: Color
    let trackColor: Color
    let lineWidth: Double
    let showsPaceMarker: Bool
    let showsProviderIcon: Bool
    let providerIconStyle: ProviderIconStyle
}

enum ProviderQuotaWidgetColorResolver {
    static func color(
        _ value: ProviderQuotaWidgetArcColor,
        customHex: String = ProviderQuotaWidgetAppearanceSettings.defaultCustomArcColorHex,
        automatic: Color = .accentColor
    ) -> Color {
        switch value {
        case .automatic: automatic
        case .accent: .accentColor
        case .blue: .blue
        case .cyan: .cyan
        case .green: .green
        case .indigo: .indigo
        case .mint: .mint
        case .orange: .orange
        case .pink: Color(red: 1.0, green: 0.40, blue: 0.72)
        case .purple: .purple
        case .red: .red
        case .teal: .teal
        case .yellow: .yellow
        case .brown: .brown
        case .gray: .gray
        case .custom: color(hex: customHex)
        }
    }

    static func color(hex: String, fallback: Color = .accentColor) -> Color {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return fallback }
        return Color(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

enum ProviderQuotaWidgetPalette {
    static func arcColor(
        urgency: ProviderQuotaUrgency,
        profile: ProviderQuotaWidgetResolvedProfile
    ) -> Color {
        let configured = ProviderQuotaWidgetArcColor(
            rawValue: profile.string(ProviderQuotaWidgetArcColor.storageKey)
        ) ?? .defaultValue
        guard configured == .automatic else {
            return ProviderQuotaWidgetColorResolver.color(
                configured,
                customHex: profile.string(ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey)
            )
        }
        let role: (String, ProviderQuotaWidgetArcColor, String) = switch urgency {
        case .healthy: (
            ProviderQuotaWidgetAppearanceSettings.healthyColorKey,
            .accent,
            ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey
        )
        case .warning: (
            ProviderQuotaWidgetAppearanceSettings.warningColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey
        )
        case .critical: (
            ProviderQuotaWidgetAppearanceSettings.criticalColorKey,
            .red,
            ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey
        )
        case .stale: (
            ProviderQuotaWidgetAppearanceSettings.staleColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey
        )
        case .unavailable: (
            ProviderQuotaWidgetAppearanceSettings.unavailableColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey
        )
        }
        return ProviderQuotaWidgetColorResolver.color(
            ProviderQuotaWidgetArcColor(rawValue: profile.string(role.0)) ?? role.1,
            customHex: profile.string(role.2)
        )
    }
}

struct ProviderQuotaGaugeView: View {
    let providerID: String?
    let displayName: String
    let sourceStatus: String
    let state: ProviderQuotaPresentationState
    let statusText: ProviderQuotaWidgetStatusText
    let resetDisplay: ProviderQuotaWidgetResetDisplay
    let style: ProviderQuotaGaugeStyle
    let compact: Bool

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.125, to: 0.875)
                .stroke(baseTrackColor, style: arcStyle)
                .rotationEffect(.degrees(90))

            if let percent = state.percent {
                Circle()
                    .trim(from: 0.125, to: 0.125 + 0.75 * percent / 100)
                    .stroke(style.arcColor, style: arcStyle)
                    .rotationEffect(.degrees(90))
                    .widgetAccentable()
            }

            if style.showsPaceMarker, let expectedPercent = state.expectedPercent {
                paceMarker(expectedPercent: expectedPercent)
            }

            VStack(spacing: compact ? 1 : 3) {
                if style.showsProviderIcon {
                    ProviderIconView(
                        providerID: providerID,
                        label: displayName,
                        size: compact ? 20 : 26,
                        style: style.providerIconStyle
                    )
                }

                Text(displayName)
                    .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.68)
                    .multilineTextAlignment(.center)

                if let percent = state.percent {
                    Text(percent, format: .percent.scale(1).precision(.fractionLength(0...1)))
                        .font(compact ? .headline : .title2.bold())
                        .monospacedDigit()
                        .minimumScaleFactor(0.72)

                    if let secondaryLabel {
                        Text(secondaryLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                } else {
                    Text(ProviderQuotaPresentation.statusLabel(sourceStatus))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(compact ? 14 : 19)
            .offset(y: style.showsProviderIcon ? (compact ? -10 : -14) : 0)

            if state.percent != nil, let resetLabel {
                Text(resetLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .padding(.horizontal, compact ? 4 : 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var arcStyle: StrokeStyle {
        StrokeStyle(lineWidth: style.lineWidth, lineCap: .round)
    }

    private var baseTrackColor: Color {
        state.percent == nil ? style.arcColor.opacity(0.55) : style.trackColor
    }

    private var secondaryLabel: String? {
        switch statusText {
        case .hidden: nil
        case .appDefault, .percentage: state.modeLabel
        case .pace: state.paceLabel
        }
    }

    private var resetLabel: String? {
        guard resetDisplay != .hidden, let resetAt = state.resetAt else { return nil }
        if resetDisplay == .exact {
            return String(localized: "Resets \(resetAt.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
        }
        let minutes = max(0, Int(resetAt.timeIntervalSince(state.referenceDate) / 60))
        let days = minutes / (24 * 60)
        let hours = minutes % (24 * 60) / 60
        if days > 0 { return String(localized: "Resets \(days)d \(hours)h") }
        if hours > 0 { return String(localized: "Resets \(hours)h \(minutes % 60)m") }
        return String(localized: "Resets \(minutes)m")
    }

    private func paceMarker(expectedPercent: Double) -> some View {
        let position = 0.125 + 0.75 * min(max(expectedPercent, 0), 100) / 100
        let halfWidth = compact ? 0.004 : 0.003
        return Circle()
            .trim(from: max(0.125, position - halfWidth), to: min(0.875, position + halfWidth))
            .stroke(Color.primary, style: StrokeStyle(lineWidth: style.lineWidth + 1, lineCap: .butt))
            .rotationEffect(.degrees(90))
            .allowsHitTesting(false)
    }

    private var accessibilityLabel: String {
        guard let percent = state.percent else {
            return "\(displayName), \(ProviderQuotaPresentation.statusLabel(sourceStatus))"
        }
        let value = percent.formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        let stale = state.isStale ? String(localized: ", stale") : ""
        return "\(displayName), \(value) \(state.modeLabel)\(stale)"
    }
}

struct ProviderQuotaForecastView: View {
    let plan: String?
    let state: ProviderQuotaPresentationState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(state.window?.label ?? "Quota")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let plan, !plan.isEmpty {
                    Text(plan)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(.secondary.opacity(0.12), in: Capsule())
                }
            }

            if let resetAt = state.resetAt {
                Label {
                    Text(resetAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
                        .lineLimit(1)
                } icon: {
                    Image(systemName: "calendar.badge.clock")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                metric(title: "Burn", value: burnRateLabel)
                metric(title: budgetTitle, value: budgetLabel)
            }

            Label(forecastLabel, systemImage: forecastSystemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(forecastTint)
                .lineLimit(2)

            HStack(spacing: 5) {
                Image(systemName: state.isStale ? "clock.badge.exclamationmark" : "clock")
                Text("Updated \(state.freshnessDate, style: .relative)")
                    .lineLimit(1)
            }
            .font(.caption2)
            .foregroundStyle(state.isStale ? .orange : .secondary)
        }
        .minimumScaleFactor(0.7)
        .accessibilityElement(children: .combine)
    }

    private func metric(title: LocalizedStringKey, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold).monospacedDigit())
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private var burnRateLabel: String {
        guard let pace = state.pace else { return "—" }
        return "\(pace.burnRate.formatted(.number.precision(.fractionLength(2))))×"
    }

    private var budgetTitle: LocalizedStringKey {
        (state.pace?.minutesToReset ?? 0) >= 24 * 60 ? "Budget / day" : "Budget / hr"
    }

    private var budgetLabel: String {
        guard let pace = state.pace,
              let remaining = state.remainingPercent,
              pace.minutesToReset > 0
        else { return "—" }
        let divisor = pace.minutesToReset >= 24 * 60
            ? pace.minutesToReset / (24 * 60)
            : pace.minutesToReset / 60
        return (remaining / divisor).formatted(.percent.scale(1).precision(.fractionLength(0...1)))
    }

    private var forecastLabel: String {
        guard let pace = state.pace else { return String(localized: "Forecast unavailable") }
        guard let projected = pace.projectedMinutesToEmpty else {
            return String(localized: "No depletion projected")
        }
        let margin = projected - pace.minutesToReset
        if margin >= 0 { return String(localized: "Lasts through reset") }
        return String(localized: "Empty \(durationLabel(abs(margin))) early")
    }

    private var forecastSystemImage: String {
        guard let pace = state.pace, let projected = pace.projectedMinutesToEmpty else {
            return "checkmark.circle"
        }
        return projected >= pace.minutesToReset ? "checkmark.circle" : "exclamationmark.triangle"
    }

    private var forecastTint: Color {
        guard let pace = state.pace, let projected = pace.projectedMinutesToEmpty else { return .secondary }
        return projected >= pace.minutesToReset ? .green : .orange
    }

    private func durationLabel(_ minutes: Double) -> String {
        let totalMinutes = max(0, Int(minutes.rounded()))
        let days = totalMinutes / (24 * 60)
        let hours = totalMinutes % (24 * 60) / 60
        if days > 0 { return String(localized: "\(days)d \(hours)h") }
        if hours > 0 { return String(localized: "\(hours)h") }
        return String(localized: "\(totalMinutes)m")
    }
}

enum ProviderQuotaUrgencyCalculator {
    static func displayWindow(
        from windows: [ProviderQuotaWindow],
        basis: ProviderQuotaWidgetColorBasis,
        selection: ProviderQuotaWidgetWindowSelection = .automatic
    ) -> ProviderQuotaWindow? {
        switch selection {
        case .session:
            return windows.first(where: { $0.label.localizedCaseInsensitiveContains("session") })
                ?? windows.first(where: { $0.label.localizedCaseInsensitiveContains("5h") })
        case .weekly:
            return windows.first(where: { $0.label.localizedCaseInsensitiveContains("week") })
        case .automatic:
            if basis == .pace {
                return windows.first(where: { $0.label.localizedCaseInsensitiveContains("week") })
                    ?? windows.first(where: { isKnownPaceWindow($0) })
            }
            return windows.first
        }
    }

    static func pace(
        for window: ProviderQuotaWindow?,
        referenceDate: Date,
        minimumElapsedHours: Int
    ) -> ProviderQuotaPace? {
        guard let window,
              let resetAt = ProviderQuotaDateParser.date(from: window.resetAt),
              resetAt > referenceDate,
              let used = ProviderQuotaPresentation.usedPercent(window),
              let remaining = ProviderQuotaPresentation.percent(window, mode: .remaining)
        else { return nil }

        let minutesToReset = max(0, (resetAt.timeIntervalSince(referenceDate) / 60).rounded())
        guard let windowMinutes = windowMinutes(for: window, minutesToReset: minutesToReset) else {
            return nil
        }
        let elapsedMinutes = max(0, Double(windowMinutes) - minutesToReset)
        let expectedRemaining = rounded(
            min(max(minutesToReset / Double(windowMinutes) * 100, 0), 100),
            digits: 1
        )
        let paceDelta = rounded(remaining - expectedRemaining, digits: 1)
        let expectedUsed = rounded(100 - expectedRemaining, digits: 1)
        let burnRate = expectedUsed > 0 ? rounded(used / expectedUsed, digits: 2) : 0
        let usagePerMinute = elapsedMinutes > 0 ? used / elapsedMinutes : 0
        let projectedMinutesToEmpty = usagePerMinute > 0 ? (remaining / usagePerMinute).rounded() : nil
        let projectionEligible = elapsedMinutes >= Double(max(0, minimumElapsedHours) * 60)
            && used >= 5
            && minutesToReset > 20
            && (projectedMinutesToEmpty ?? .infinity) < minutesToReset
        return ProviderQuotaPace(
            expectedRemainingPercent: expectedRemaining,
            paceDeltaPercent: paceDelta,
            burnRate: burnRate,
            minutesToReset: minutesToReset,
            projectedMinutesToEmpty: projectedMinutesToEmpty,
            projectionEligible: projectionEligible
        )
    }

    static func urgency(
        windows: [ProviderQuotaWindow],
        status: String,
        isStale: Bool,
        referenceDate: Date = Date(),
        basis: ProviderQuotaWidgetColorBasis,
        warningRemainingPercent: Int,
        criticalRemainingPercent: Int,
        paceTolerancePercent: Int,
        paceWarningBurnRatePercent: Int,
        paceCriticalBurnRatePercent: Int,
        paceMinimumElapsedHours: Int,
        windowSelection: ProviderQuotaWidgetWindowSelection = .automatic
    ) -> ProviderQuotaUrgency {
        if isStale { return .stale }
        guard status == "available",
              let window = displayWindow(from: windows, basis: basis, selection: windowSelection),
              let remaining = ProviderQuotaPresentation.percent(window, mode: .remaining)
        else {
            return status == "available" ? .healthy : .unavailable
        }

        if basis == .pace,
           let pace = pace(for: window, referenceDate: referenceDate, minimumElapsedHours: paceMinimumElapsedHours) {
            if pace.projectionEligible && pace.burnRate >= Double(max(0, paceCriticalBurnRatePercent)) / 100 {
                return .critical
            }
            if pace.projectionEligible && pace.burnRate >= Double(max(0, paceWarningBurnRatePercent)) / 100 {
                return .warning
            }
            return pace.paceDeltaPercent <= -Double(max(0, paceTolerancePercent)) ? .warning : .healthy
        }

        if remaining <= Double(max(0, criticalRemainingPercent)) { return .critical }
        if remaining <= Double(max(0, warningRemainingPercent)) { return .warning }
        return .healthy
    }

    private static func rounded(_ value: Double, digits: Int) -> Double {
        let scale = pow(10, Double(digits))
        return (value * scale).rounded() / scale
    }

    private static func isKnownPaceWindow(_ window: ProviderQuotaWindow) -> Bool {
        window.windowSeconds == 18_000
            || window.windowSeconds == 604_800
            || window.label.localizedCaseInsensitiveContains("week")
            || window.label.localizedCaseInsensitiveContains("session")
            || window.label.localizedCaseInsensitiveContains("5h")
    }

    private static func windowMinutes(for window: ProviderQuotaWindow, minutesToReset: Double) -> Int? {
        if let seconds = window.windowSeconds {
            if seconds == 18_000 { return 5 * 60 }
            if seconds == 604_800 { return 7 * 24 * 60 }
            return nil
        }
        if window.label.localizedCaseInsensitiveContains("week") { return 7 * 24 * 60 }
        if window.label.localizedCaseInsensitiveContains("5h") { return 5 * 60 }
        if window.label.localizedCaseInsensitiveContains("session") {
            return minutesToReset > 5 * 60 ? 7 * 24 * 60 : 5 * 60
        }
        return nil
    }
}

enum ProviderQuotaDisplaySettings {
    static let aliasesKey = "providerQuota.providerAliases"

    static func aliases(from data: Data) -> [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    static func data(
        byRenaming providerID: String,
        to name: String,
        in data: Data
    ) -> Data {
        let providerID = providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !providerID.isEmpty else { return data }
        var aliases = aliases(from: data)
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            aliases.removeValue(forKey: providerID)
        } else {
            aliases[providerID] = String(name.prefix(64))
        }
        return (try? JSONEncoder().encode(aliases)) ?? data
    }

    static func displayName(
        providerID: String?,
        fallback: String,
        aliasesData: Data
    ) -> String {
        guard let providerID else { return fallback }
        return aliases(from: aliasesData)[providerID.lowercased()] ?? fallback
    }
}

enum ProviderQuotaWidgetSelection {
    static func sourceIDs(slotIDs: [String?], capacity: Int) -> [String] {
        slotIDs.prefix(max(0, min(capacity, 4))).compactMap { raw in
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    static func resolve(
        sourceIDs: [String],
        snapshot: ProviderQuotaWidgetSnapshot?
    ) -> [ProviderQuotaWidgetSource?] {
        let byID = Dictionary(uniqueKeysWithValues: (snapshot?.sources ?? []).map { ($0.sourceID, $0) })
        return sourceIDs.map { byID[$0] }
    }
}

enum ProviderQuotaDateParser {
    static func date(from value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return ISO8601DateFormatter().date(from: value) ?? fractional.date(from: value)
    }
}

enum ProviderQuotaPresentation {
    static func state(
        for source: ProviderQuotaWidgetSource,
        settings: ProviderQuotaEvaluationSettings,
        at referenceDate: Date,
        windowOverride: ProviderQuotaWindow? = nil
    ) -> ProviderQuotaPresentationState {
        let window = windowOverride ?? ProviderQuotaUrgencyCalculator.displayWindow(
            from: source.windows,
            basis: settings.colorBasis,
            selection: settings.windowSelection
        )
        let usedFromQuota: Double? = {
            guard let usage = source.quota?.usage,
                  let limit = source.quota?.limit,
                  limit > 0
            else { return nil }
            return min(max(usage / limit * 100, 0), 100)
        }()
        let displayedPercent = window.flatMap { percent($0, mode: settings.percentageMode) }
            ?? usedFromQuota.map { settings.percentageMode == .used ? $0 : 100 - $0 }
        let remaining = window.flatMap { percent($0, mode: .remaining) }
            ?? usedFromQuota.map { 100 - $0 }
        let pace = ProviderQuotaUrgencyCalculator.pace(
            for: window,
            referenceDate: referenceDate,
            minimumElapsedHours: settings.paceMinimumElapsedHours
        )
        let isStale = referenceDate.timeIntervalSince(source.freshnessDate) > ProviderQuotaWidgetSnapshot.staleAfter
        let urgency = ProviderQuotaUrgencyCalculator.urgency(
            windows: windowOverride.map { [$0] } ?? source.windows,
            status: source.status,
            isStale: isStale,
            referenceDate: referenceDate,
            basis: settings.colorBasis,
            warningRemainingPercent: settings.warningRemainingPercent,
            criticalRemainingPercent: settings.criticalRemainingPercent,
            paceTolerancePercent: settings.paceTolerancePercent,
            paceWarningBurnRatePercent: settings.paceWarningBurnRatePercent,
            paceCriticalBurnRatePercent: settings.paceCriticalBurnRatePercent,
            paceMinimumElapsedHours: settings.paceMinimumElapsedHours,
            windowSelection: windowOverride == nil ? settings.windowSelection : .automatic
        )
        return ProviderQuotaPresentationState(
            window: window,
            percent: displayedPercent,
            remainingPercent: remaining,
            resetAt: ProviderQuotaDateParser.date(from: window?.resetAt),
            referenceDate: referenceDate,
            freshnessDate: source.freshnessDate,
            isStale: isStale,
            pace: pace,
            urgency: urgency,
            settings: settings
        )
    }

    static func usedPercent(_ window: ProviderQuotaWindow) -> Double? {
        if let used = window.usedPercent, used.isFinite { return min(max(used, 0), 100) }
        if let remaining = window.remainingPercent, remaining.isFinite { return min(max(100 - remaining, 0), 100) }
        return nil
    }

    static func percent(_ window: ProviderQuotaWindow, mode: ProviderQuotaPercentageMode) -> Double? {
        guard let used = usedPercent(window) else { return nil }
        return mode == .used ? used : 100 - used
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "available": String(localized: "Available")
        case "exhausted": String(localized: "Quota exhausted")
        case "invalid_key", "no_key": String(localized: "Authentication required")
        case "removed": String(localized: "Account removed")
        case "unsupported": String(localized: "Quota not supported")
        case "dead": String(localized: "Credential unavailable")
        default: String(localized: "Quota unavailable")
        }
    }
}

struct ProviderQuotaWidgetSavedProfile: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    var values: [String: String]
}

enum ProviderQuotaWidgetProfileStore {
    static let defaultProfileID = "default"
    static let storageKey = "providerQuota.widgetProfiles.v1"
    static let selectedDefaultProfileKey = "providerQuota.widgetDefaultProfileID"

    static func profiles(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> [ProviderQuotaWidgetSavedProfile] {
        guard let data = defaults.data(forKey: storageKey) else { return [] }
        return ((try? JSONDecoder().decode([ProviderQuotaWidgetSavedProfile].self, from: data)) ?? [])
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    @discardableResult
    static func saveCurrent(
        name: String,
        id: String = UUID().uuidString,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> ProviderQuotaWidgetSavedProfile? {
        let name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(48))
        guard !name.isEmpty else { return nil }
        let profile = ProviderQuotaWidgetSavedProfile(id: id, name: name, values: currentValues(defaults: defaults))
        var profiles = profiles(defaults: defaults).filter { $0.id != id }
        profiles.append(profile)
        guard let data = try? JSONEncoder().encode(profiles) else { return nil }
        defaults.set(data, forKey: storageKey)
        return profile
    }

    static func delete(
        id: String,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) {
        guard id != defaultProfileID else { return }
        let remaining = profiles(defaults: defaults).filter { $0.id != id }
        defaults.set(try? JSONEncoder().encode(remaining), forKey: storageKey)
        if selectedDefaultProfileID(defaults: defaults) == id {
            defaults.removeObject(forKey: selectedDefaultProfileKey)
        }
    }

    static func selectedDefaultProfileID(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> String? {
        guard let id = defaults.string(forKey: selectedDefaultProfileKey),
              profiles(defaults: defaults).contains(where: { $0.id == id })
        else { return nil }
        return id
    }

    static func setDefault(
        id: String?,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) {
        guard let id,
              id != defaultProfileID,
              profiles(defaults: defaults).contains(where: { $0.id == id })
        else {
            defaults.removeObject(forKey: selectedDefaultProfileKey)
            return
        }
        defaults.set(id, forKey: selectedDefaultProfileKey)
    }

    static func apply(
        _ profile: ProviderQuotaWidgetSavedProfile,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) {
        let booleanKeys: Set<String> = [
            ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey,
            ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey,
        ]
        let integerKeys: Set<String> = [
            ProviderQuotaWidgetBackground.opacityPercentKey,
            ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey,
            ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey,
            ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey,
            ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey,
        ]
        for (key, value) in profile.values {
            if booleanKeys.contains(key) {
                defaults.set(["1", "true", "yes", "on"].contains(value.lowercased()), forKey: key)
            } else if integerKeys.contains(key), let integer = Int(value) {
                defaults.set(integer, forKey: key)
            } else {
                defaults.set(value, forKey: key)
            }
        }
    }

    static func profile(
        id: String?,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> ProviderQuotaWidgetSavedProfile? {
        guard let id, id != defaultProfileID else { return nil }
        return profiles(defaults: defaults).first { $0.id == id }
    }

    static func currentValues(
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> [String: String] {
        var values = defaultValues
        for key in defaultValues.keys {
            guard let value = defaults.object(forKey: key) else { continue }
            if let string = value as? String {
                values[key] = string
            } else if let number = value as? NSNumber {
                values[key] = number.stringValue
            }
        }
        return values
    }

    static var defaultValues: [String: String] {
        [
            ProviderQuotaPercentageMode.storageKey: ProviderQuotaPercentageMode.defaultValue.rawValue,
            ProviderQuotaWidgetWindowSelection.storageKey: ProviderQuotaWidgetWindowSelection.defaultValue.rawValue,
            ProviderQuotaWidgetArcColor.storageKey: ProviderQuotaWidgetArcColor.defaultValue.rawValue,
            ProviderQuotaWidgetArcWeight.storageKey: ProviderQuotaWidgetArcWeight.defaultValue.rawValue,
            ProviderQuotaWidgetColorBasis.storageKey: ProviderQuotaWidgetColorBasis.defaultValue.rawValue,
            ProviderQuotaWidgetStatusText.storageKey: ProviderQuotaWidgetStatusText.defaultValue.rawValue,
            ProviderQuotaWidgetResetDisplay.storageKey: ProviderQuotaWidgetResetDisplay.defaultValue.rawValue,
            ProviderQuotaWidgetTapAction.storageKey: ProviderQuotaWidgetTapAction.defaultValue.rawValue,
            ProviderQuotaWidgetBackground.storageKey: ProviderQuotaWidgetBackground.defaultValue.rawValue,
            ProviderQuotaWidgetBackground.customColorHexKey: ProviderQuotaWidgetBackground.defaultCustomColorHex,
            ProviderQuotaWidgetBackground.opacityPercentKey: String(ProviderQuotaWidgetBackground.defaultOpacityPercent),
            ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey: String(ProviderQuotaWidgetAppearanceSettings.defaultShowsProviderIcon),
            ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey: ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle.rawValue,
            ProviderQuotaWidgetAppearanceSettings.healthyColorKey: ProviderQuotaWidgetAppearanceSettings.defaultHealthyColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.warningColorKey: ProviderQuotaWidgetAppearanceSettings.defaultWarningColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.criticalColorKey: ProviderQuotaWidgetAppearanceSettings.defaultCriticalColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.staleColorKey: ProviderQuotaWidgetAppearanceSettings.defaultStaleColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.unavailableColorKey: ProviderQuotaWidgetAppearanceSettings.defaultUnavailableColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultWarningRemainingPercent),
            ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultCriticalRemainingPercent),
            ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceTolerancePercent),
            ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceWarningBurnRatePercent),
            ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceCriticalBurnRatePercent),
            ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey: String(ProviderQuotaWidgetAppearanceSettings.defaultPaceMinimumElapsedHours),
            ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey: String(ProviderQuotaWidgetAppearanceSettings.defaultShowsPaceMarker),
            ProviderQuotaWidgetAppearanceSettings.trackColorKey: ProviderQuotaWidgetAppearanceSettings.defaultTrackColor.rawValue,
            ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey: String(ProviderQuotaWidgetAppearanceSettings.defaultTrackOpacityPercent),
            ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomArcColorHex,
            ProviderQuotaWidgetAppearanceSettings.customTrackColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomTrackColorHex,
            ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomHealthyColorHex,
            ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomWarningColorHex,
            ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomCriticalColorHex,
            ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomStaleColorHex,
            ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey: ProviderQuotaWidgetAppearanceSettings.defaultCustomUnavailableColorHex,
        ]
    }
}

struct ProviderQuotaWidgetResolvedProfile {
    let id: String
    let name: String
    let values: [String: String]

    static func resolve(
        id: String?,
        followsSelectedDefault: Bool = true,
        defaults: UserDefaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) -> ProviderQuotaWidgetResolvedProfile {
        let resolvedID = if (id == nil || id == ProviderQuotaWidgetProfileStore.defaultProfileID),
                            followsSelectedDefault {
            ProviderQuotaWidgetProfileStore.selectedDefaultProfileID(defaults: defaults)
        } else {
            id
        }
        if let profile = ProviderQuotaWidgetProfileStore.profile(id: resolvedID, defaults: defaults) {
            return ProviderQuotaWidgetResolvedProfile(id: profile.id, name: profile.name, values: profile.values)
        }
        return ProviderQuotaWidgetResolvedProfile(
            id: ProviderQuotaWidgetProfileStore.defaultProfileID,
            name: String(localized: "App Default"),
            values: ProviderQuotaWidgetProfileStore.currentValues(defaults: defaults)
        )
    }

    func string(_ key: String) -> String {
        values[key] ?? ProviderQuotaWidgetProfileStore.defaultValues[key] ?? ""
    }

    func integer(_ key: String) -> Int {
        Int(string(key)) ?? Int(ProviderQuotaWidgetProfileStore.defaultValues[key] ?? "") ?? 0
    }

    func boolean(_ key: String) -> Bool {
        ["1", "true", "yes", "on"].contains(string(key).lowercased())
    }
}

struct ProviderQuotaWidgetProfileEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Widget Profile")
    static var defaultQuery = ProviderQuotaWidgetProfileEntityQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ProviderQuotaWidgetProfileEntityQuery: EnumerableEntityQuery {
    func entities(for identifiers: [String]) async throws -> [ProviderQuotaWidgetProfileEntity] {
        let wanted = Set(identifiers)
        return allProfiles().filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaWidgetProfileEntity] { allProfiles() }

    func defaultResult() async -> ProviderQuotaWidgetProfileEntity? {
        let profiles = allProfiles()
        guard let selectedID = ProviderQuotaWidgetProfileStore.selectedDefaultProfileID() else {
            return profiles.first
        }
        return profiles.first { $0.id == selectedID } ?? profiles.first
    }

    private func allProfiles() -> [ProviderQuotaWidgetProfileEntity] {
        [ProviderQuotaWidgetProfileEntity(id: ProviderQuotaWidgetProfileStore.defaultProfileID, name: String(localized: "App Default"))]
            + ProviderQuotaWidgetProfileStore.profiles().map {
                ProviderQuotaWidgetProfileEntity(id: $0.id, name: $0.name)
            }
    }
}

struct ProviderQuotaSourceEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota source")
    static var defaultQuery = ProviderQuotaSourceEntityQuery()

    let id: String
    let name: String
    let scopeLabel: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(scopeLabel)")
    }

    init(source: ProviderQuotaWidgetSource, aliasesData: Data = Data()) {
        id = source.sourceID
        name = ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: aliasesData
        )
        scopeLabel = source.scopeLabel
    }
}

struct ProviderQuotaSourceEntityQuery: EnumerableEntityQuery {
    func entities(for identifiers: [ProviderQuotaSourceEntity.ID]) async throws -> [ProviderQuotaSourceEntity] {
        let wanted = Set(identifiers)
        return Self.currentEntities(includeRemoved: true).filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaSourceEntity] {
        Self.currentEntities(includeRemoved: false)
    }

    fileprivate static func currentEntities(includeRemoved: Bool) -> [ProviderQuotaSourceEntity] {
        let aliasesData = ProviderQuotaWidgetSnapshotStore.appGroupDefaults.data(
            forKey: ProviderQuotaDisplaySettings.aliasesKey
        ) ?? Data()
        return (ProviderQuotaWidgetSnapshotStore().load()?.sources ?? [])
            .filter { includeRemoved || $0.status != "removed" }
            .map { ProviderQuotaSourceEntity(source: $0, aliasesData: aliasesData) }
    }
}

struct ProviderQuotaPrimarySourceEntityQuery: EnumerableEntityQuery {
    func entities(for identifiers: [ProviderQuotaSourceEntity.ID]) async throws -> [ProviderQuotaSourceEntity] {
        let wanted = Set(identifiers)
        return ProviderQuotaSourceEntityQuery.currentEntities(includeRemoved: true)
            .filter { wanted.contains($0.id) }
    }

    func allEntities() async throws -> [ProviderQuotaSourceEntity] {
        ProviderQuotaSourceEntityQuery.currentEntities(includeRemoved: false)
    }

    func defaultResult() async -> ProviderQuotaSourceEntity? {
        ProviderQuotaSourceEntityQuery.currentEntities(includeRemoved: false).first
    }
}

struct ProviderQuotaWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Provider quotas"
    static var description = IntentDescription("Choose the provider accounts shown in this widget.")

    @Parameter(title: "Source 1", query: ProviderQuotaPrimarySourceEntityQuery()) var source1: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 2", query: ProviderQuotaSourceEntityQuery()) var source2: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 3", query: ProviderQuotaSourceEntityQuery()) var source3: ProviderQuotaSourceEntity?
    @Parameter(title: "Source 4", query: ProviderQuotaSourceEntityQuery()) var source4: ProviderQuotaSourceEntity?
    @Parameter(title: "Profile", query: ProviderQuotaWidgetProfileEntityQuery()) var profile: ProviderQuotaWidgetProfileEntity?
    @Parameter(title: "Quota Window", default: .automatic) var windowSelection: ProviderQuotaWidgetWindowSelection
    @Parameter(title: "Percentage", default: .appDefault) var percentageMode: ProviderQuotaWidgetPercentageOverride
    @Parameter(title: "Status Text", default: .appDefault) var statusText: ProviderQuotaWidgetStatusText
    @Parameter(title: "Reset Display", default: .appDefault) var resetDisplay: ProviderQuotaWidgetResetDisplay
    @Parameter(title: "Color Basis", default: .appDefault) var colorBasis: ProviderQuotaWidgetBasisOverride
    @Parameter(title: "Gauge Color", default: .appDefault) var gaugeColor: ProviderQuotaWidgetColorOverride
    @Parameter(title: "Gauge Weight", default: .appDefault) var gaugeWeight: ProviderQuotaWidgetWeightOverride
    @Parameter(title: "Track Color", default: .appDefault) var trackColor: ProviderQuotaWidgetColorOverride
    @Parameter(title: "Pace Marker", default: .appDefault) var paceMarker: ProviderQuotaWidgetPaceMarkerOverride
    @Parameter(title: "Background", default: .appDefault) var background: ProviderQuotaWidgetBackground
    @Parameter(title: "Tap Action", default: .appDefault) var tapAction: ProviderQuotaWidgetTapAction

    static var parameterSummary: some ParameterSummary {
        Switch(.widgetFamily) {
            Case(.systemSmall) {
                Summary("Show \(\.$source1)") {
                    \.$profile
                }
            }
            Case([.accessoryInline, .accessoryCircular, .accessoryRectangular]) {
                Summary("Show \(\.$source1)")
            }
            Case(.systemMedium) {
                Summary("Show \(\.$source1) and \(\.$source2)") {
                    \.$profile
                }
            }
            DefaultCase {
                Summary("Show \(\.$source1), \(\.$source2), \(\.$source3), and \(\.$source4)") {
                    \.$profile
                }
            }
        }
    }

    var sourceIDs: [String?] {
        [source1?.id, source2?.id, source3?.id, source4?.id]
    }
}
