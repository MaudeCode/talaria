import Foundation
import LDSwiftEventSource

/// Builds an `EventSource` for one of the server's SSE streams with the app's identity, cookies,
/// custom headers and cross-origin redirect guard. Transport errors shut the source down; each
/// caller owns its own reconnect. The caller unregisters the returned policy header on stop.
@MainActor
enum ServerEventSource {
    static func make(
        url: URL,
        handler: EventHandler,
        baseConfiguration: URLSessionConfiguration,
        customHeaders: [CustomHeader]
    ) -> (source: EventSource, redirectPolicyHeader: String) {
        var config = EventSource.Config(handler: handler, url: url)
        config.connectionErrorHandler = { _ in .shutdown }
        let cookieStorage = ServerCookieStore.shared.storage(for: url)
        var builtInHeaders = [
            AppConfig.clientIdentityHeaderName: AppConfig.clientIdentity,
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Accept-Encoding": "identity"
        ]
        if let cookie = HTTPCookie.requestHeaderFields(
            with: cookieStorage.cookies(for: url) ?? []
        )["Cookie"] {
            builtInHeaders["Cookie"] = cookie
        }
        config.headers = customHeaders.merged(under: builtInHeaders)

        let configuration = baseConfiguration.copy() as? URLSessionConfiguration ?? .default
        #if DEBUG
        UITestURLSessionHook.configure(configuration)
        #endif
        configuration.httpCookieStorage = cookieStorage
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let policyHeader = CrossOriginRedirectGuardURLProtocol.register(
            configuration: configuration,
            baseURL: url,
            customHeaders: customHeaders,
            builtInHeaders: builtInHeaders
        )
        configuration.protocolClasses = [CrossOriginRedirectGuardURLProtocol.self]
            + (configuration.protocolClasses ?? []).filter { $0 != CrossOriginRedirectGuardURLProtocol.self }
        config.headers[policyHeader] = "1"
        config.urlSessionConfiguration = configuration

        return (EventSource(config: config), policyHeader)
    }
}
