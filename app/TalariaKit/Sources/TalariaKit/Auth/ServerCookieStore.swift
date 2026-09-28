import Foundation
import os

public final class ServerCookieStore: @unchecked Sendable {
    public static let shared = ServerCookieStore()

    private let keychain: any KeychainStoring
    private let legacyStorage: HTTPCookieStorage
    private let storages = OSAllocatedUnfairLock(initialState: [String: HTTPCookieStorage]())

    public init(
        keychain: any KeychainStoring = KeychainStore(),
        legacyStorage: HTTPCookieStorage = .shared
    ) {
        self.keychain = keychain
        self.legacyStorage = legacyStorage
    }

    public func storage(for server: URL) -> HTTPCookieStorage {
        let server = Self.scopeURL(for: server)
        let scope = server.absoluteString
        return storages.withLock { storages in
            if let existing = storages[scope] { return existing }

            let storage = Self.makeIsolatedStorage()
            if let encoded = try? keychain.load(.sessionCookies, scope: scope),
               let data = encoded.data(using: .utf8),
               let cookies = try? JSONDecoder().decode([StoredCookie].self, from: data) {
                cookies.compactMap(\.cookie).forEach(storage.setCookie)
            } else {
                // One-time migration from the legacy shared jar. The first exact
                // server URL to claim a host gets its old cookie; a second port
                // fails closed instead of inheriting that credential.
                let legacy = legacyStorage.cookies(for: server) ?? []
                legacy.forEach(storage.setCookie)
                if !legacy.isEmpty {
                    do {
                        try persist(legacy, for: server)
                        legacy.forEach(legacyStorage.deleteCookie)
                    } catch {
                        // Keep the legacy source intact so migration can retry.
                    }
                }
            }
            storages[scope] = storage
            return storage
        }
    }

    public func persist(for server: URL) throws {
        let server = Self.scopeURL(for: server)
        try persist(storage(for: server).cookies(for: server) ?? [], for: server)
    }

    private func persist(_ cookies: [HTTPCookie], for server: URL) throws {
        let cookies = cookies.map(StoredCookie.init)
        guard !cookies.isEmpty,
              let data = try? JSONEncoder().encode(cookies),
              let encoded = String(data: data, encoding: .utf8)
        else {
            try keychain.delete(.sessionCookies, scope: server.absoluteString)
            return
        }
        try keychain.save(encoded, forKey: .sessionCookies, scope: server.absoluteString)
    }

    public func clear(for server: URL) {
        let server = Self.scopeURL(for: server)
        let storage = storage(for: server)
        storage.cookies?.forEach(storage.deleteCookie)
        try? keychain.delete(.sessionCookies, scope: server.absoluteString)
    }

    public static func makeIsolatedStorage() -> HTTPCookieStorage {
        URLSessionConfiguration.ephemeral.httpCookieStorage ?? HTTPCookieStorage()
    }

    private static func scopeURL(for url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url ?? url
    }
}

private struct StoredCookie: Codable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let expiresDate: Date?
    let isSecure: Bool
    let isHTTPOnly: Bool

    init(_ cookie: HTTPCookie) {
        name = cookie.name
        value = cookie.value
        domain = cookie.domain
        path = cookie.path
        expiresDate = cookie.expiresDate
        isSecure = cookie.isSecure
        isHTTPOnly = cookie.isHTTPOnly
    }

    var cookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
            .secure: isSecure ? "TRUE" : "FALSE"
        ]
        if let expiresDate { properties[.expires] = expiresDate }
        if isHTTPOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        return HTTPCookie(properties: properties)
    }
}
