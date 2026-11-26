import Foundation

enum ScreenLeaseAction: String, Encodable, Sendable {
    case acquire, release
}

protocol ScreenServing: Sendable {
    func screen(sessionID: String) async throws -> AgentScreen?
    func openScreen(viewID: String) async throws -> any RFBSocket
    func screenView(viewID: String) async throws -> AgentScreen
    func screenLease(viewID: String, action: ScreenLeaseAction) async throws -> AgentScreen
}

extension APIClient: ScreenServing {
    func screen(sessionID: String) async throws -> AgentScreen? {
        try await session(id: sessionID, includeMessages: false).session?.screen
    }

    func openScreen(viewID: String) throws -> any RFBSocket {
        let endpoint = Endpoint.screenStream(viewID: viewID).url(relativeTo: baseURL)
        guard var url = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http"
        else { throw APIError.invalidServerURL }
        url.scheme = scheme == "https" ? "wss" : "ws"
        guard let socketURL = url.url else { throw APIError.invalidServerURL }
        var request = URLRequest(url: socketURL)
        customHeaderProvider().apply(to: &request)
        AppConfig.applyClientIdentity(to: &request)
        // The same server's session supplies its login and profile cookies.
        let task = session.webSocketTask(with: request)
        task.delegate = ScreenRedirectGuard()
        task.maximumMessageSize = 64 * 1024 * 1024
        task.resume()
        return NativeRFBSocket(task: task)
    }

    func screenView(viewID: String) async throws -> AgentScreen {
        try await send(endpoint: .screenView(viewID: viewID), method: "GET", body: Optional<EmptyBody>.none, timeout: 10)
    }

    func screenLease(viewID: String, action: ScreenLeaseAction) async throws -> AgentScreen {
        struct Lease: Encodable {
            let viewId: String
            let action: ScreenLeaseAction
        }
        return try await send(endpoint: .screenLease, method: "POST", body: Lease(viewId: viewID, action: action), timeout: 10)
    }
}

/// Never send the login, custom headers, pictures or input to a redirected socket.
private final class ScreenRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
