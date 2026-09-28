import Foundation
import Security

public enum ProviderQuotaRefreshInterval: Int, CaseIterable, Identifiable {
    case oneMinute = 60
    case fiveMinutes = 300
    case fifteenMinutes = 900
    case thirtyMinutes = 1_800

    public static let storageKey = "providerQuota.refreshIntervalSeconds"
    public static let defaultValue = ProviderQuotaRefreshInterval.fiveMinutes

    public var id: Int { rawValue }
    public var duration: Duration { .seconds(rawValue) }

    public var title: String {
        switch self {
        case .oneMinute: String(localized: "Every minute")
        case .fiveMinutes: String(localized: "Every 5 minutes")
        case .fifteenMinutes: String(localized: "Every 15 minutes")
        case .thirtyMinutes: String(localized: "Every 30 minutes")
        }
    }

    public static func storedValue(_ rawValue: Int) -> ProviderQuotaRefreshInterval {
        ProviderQuotaRefreshInterval(rawValue: rawValue) ?? defaultValue
    }
}

public enum ProviderQuotaWidgetTimelinePolicy {
    public static func nextRefreshDate(
        credentials: ProviderQuotaWidgetRefreshCredentials?,
        now: Date
    ) -> Date {
        let interval = max(
            credentials?.refreshIntervalSeconds ?? ProviderQuotaRefreshInterval.defaultValue.rawValue,
            ProviderQuotaRefreshInterval.fiveMinutes.rawValue
        )
        return now.addingTimeInterval(TimeInterval(interval))
    }
}

public struct ProviderQuotaWidgetRefreshHeader: Codable, Equatable, Sendable {
    let name: String
    let value: String

    public init(name: String, value: String) {
        self.name = name
        self.value = value
    }
}

public struct ProviderQuotaWidgetRefreshCookie: Codable, Equatable, Sendable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let isSecure: Bool
    let expiresDate: Date?

    init(
        name: String,
        value: String,
        domain: String,
        path: String,
        isSecure: Bool,
        expiresDate: Date?
    ) {
        self.name = name
        self.value = value
        self.domain = domain
        self.path = path
        self.isSecure = isSecure
        self.expiresDate = expiresDate
    }

    public init(_ cookie: HTTPCookie) {
        self.init(
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            isSecure: cookie.isSecure,
            expiresDate: cookie.expiresDate
        )
    }

    func applies(to url: URL, at date: Date) -> Bool {
        guard expiresDate.map({ $0 > date }) ?? true,
              !isSecure || url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              !name.isEmpty,
              name.rangeOfCharacter(from: CharacterSet(charactersIn: "=;\r\n")) == nil,
              value.rangeOfCharacter(from: CharacterSet(charactersIn: ";\r\n")) == nil
        else { return false }
        let cookieDomain = domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !cookieDomain.isEmpty,
              host == cookieDomain || host.hasSuffix(".\(cookieDomain)")
        else { return false }
        let cookiePath = path.isEmpty ? "/" : path
        let requestPath = url.path.isEmpty ? "/" : url.path
        return cookiePath == "/"
            || requestPath == cookiePath
            || requestPath.hasPrefix(cookiePath.hasSuffix("/") ? cookiePath : "\(cookiePath)/")
    }

    var identity: String { "\(name)|\(domain)|\(path)" }
}

public struct ProviderQuotaWidgetRefreshCredentials: Codable, Equatable, Sendable {
    let serverURLString: String
    let serverLabel: String
    public let refreshIntervalSeconds: Int
    let headers: [ProviderQuotaWidgetRefreshHeader]
    let cookies: [ProviderQuotaWidgetRefreshCookie]

    public init(serverURLString: String, serverLabel: String, refreshIntervalSeconds: Int, headers: [ProviderQuotaWidgetRefreshHeader], cookies: [ProviderQuotaWidgetRefreshCookie]) {
        self.serverURLString = serverURLString
        self.serverLabel = serverLabel
        self.refreshIntervalSeconds = refreshIntervalSeconds
        self.headers = headers
        self.cookies = cookies
    }

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

public enum ProviderQuotaWidgetRefreshCredentialStore {
    private static let account = "active-provider-quota-refresh.v1"

    public static func load() -> ProviderQuotaWidgetRefreshCredentials? {
        guard let baseQuery else { return nil }
        return load(query: baseQuery)
    }

    public static func load(query baseQuery: [String: Any]) -> ProviderQuotaWidgetRefreshCredentials? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(ProviderQuotaWidgetRefreshCredentials.self, from: data)
    }

    @discardableResult
    public static func save(_ credentials: ProviderQuotaWidgetRefreshCredentials) -> Bool {
        guard let baseQuery else { return false }
        return save(credentials, query: baseQuery)
    }

    @discardableResult
    static func save(
        _ credentials: ProviderQuotaWidgetRefreshCredentials,
        query baseQuery: [String: Any]
    ) -> Bool {
        guard let data = try? JSONEncoder().encode(credentials) else { return false }
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
    public static func clear() -> Bool {
        guard let baseQuery else { return false }
        return clear(query: baseQuery)
    }

    @discardableResult
    public static func clear(query: [String: Any]) -> Bool {
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    static func query(accessGroup: String?, service: String, account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    private static var baseQuery: [String: Any]? {
        guard let accessGroup = sharedAccessGroup else { return nil }
        return query(accessGroup: accessGroup, service: sharedService, account: account)
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

public enum ProviderQuotaWidgetRefreshClient {
    public static func refreshFromSharedCredentials() async -> Bool {
        guard let credentials = ProviderQuotaWidgetRefreshCredentialStore.load() else { return false }
        return await refresh(credentials: credentials)
    }

    public static func refresh(
        credentials: ProviderQuotaWidgetRefreshCredentials,
        snapshotStore: ProviderQuotaWidgetSnapshotStore = ProviderQuotaWidgetSnapshotStore(),
        now: Date = Date(),
        saveCredentials: (ProviderQuotaWidgetRefreshCredentials) -> Bool = ProviderQuotaWidgetRefreshCredentialStore.save,
        reloadTimelines: () -> Void = ProviderQuotaWidgetSnapshotStore.reloadTimelines,
        performRequest: ((URLRequest) async throws -> (Data, URLResponse))? = nil
    ) async -> Bool {
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
        let cookieHeader = credentials.cookies
            .filter { $0.applies(to: url, at: now) }
            .sorted { $0.identity < $1.identity }
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ")
        if !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        AppConfig.applyClientIdentity(to: &request)

        let session: URLSession?
        if performRequest == nil {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            session = URLSession(
                configuration: configuration,
                delegate: ProviderQuotaWidgetRedirectDelegate(baseURL: baseURL),
                delegateQueue: nil
            )
        } else {
            session = nil
        }
        defer { session?.finishTasksAndInvalidate() }

        do {
            let (data, response): (Data, URLResponse)
            if let performRequest {
                (data, response) = try await performRequest(request)
            } else if let session {
                (data, response) = try await session.data(for: request)
            } else {
                return false
            }
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let quotaResponse = decodeResponse(data),
                  quotaResponse.version == 1,
                  let scopeID = quotaResponse.scopeID,
                  !scopeID.isEmpty
            else { return false }

            persistResponseCookies(
                from: httpResponse,
                url: url,
                credentials: credentials,
                saveCredentials: saveCredentials
            )
            let profileID = quotaResponse.profileID ?? "default"
            let sources = quotaResponse.sources.map {
                ProviderQuotaWidgetSource(
                    $0,
                    scopeID: scopeID,
                    scopeLabel: "\(credentials.serverLabel) · \(profileID)"
                )
            }
            guard snapshotStore.save(scopeID: scopeID, sources: sources) else {
                return false
            }
            reloadTimelines()
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

    private static func decodeResponse(_ data: Data) -> ProviderQuotasResponse? {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try? decoder.decode(ProviderQuotasResponse.self, from: data)
    }

    private static func persistResponseCookies(
        from response: HTTPURLResponse,
        url: URL,
        credentials: ProviderQuotaWidgetRefreshCredentials,
        saveCredentials: (ProviderQuotaWidgetRefreshCredentials) -> Bool
    ) {
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String, let value = entry.value as? String else { return }
            result[key] = value
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
        guard !cookies.isEmpty else { return }
        _ = saveCredentials(credentials.merging(responseCookies: cookies))
    }
}

final class ProviderQuotaWidgetRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
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
