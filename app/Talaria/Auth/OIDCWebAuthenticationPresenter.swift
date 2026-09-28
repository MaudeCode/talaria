import AuthenticationServices
import TalariaKit
import UIKit

@MainActor
final class OIDCWebAuthenticationPresenter: NSObject,
    ASWebAuthenticationPresentationContextProviding {
    static let shared = OIDCWebAuthenticationPresenter()

    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        guard session == nil else { throw OIDCSignInError.alreadyInProgress }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callback, error in
                Task { @MainActor in
                    self?.session = nil
                    if let callback {
                        continuation.resume(returning: callback)
                    } else if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(throwing: OIDCSignInError.invalidCallback)
                    }
                }
            }
            session.presentationContextProvider = self
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: OIDCSignInError.presentationFailed)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
    }
}
