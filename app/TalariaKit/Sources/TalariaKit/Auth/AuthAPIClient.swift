import Foundation

public protocol AuthAPIClient: Sendable {
    func health() async throws -> HealthResponse
    func authStatus() async throws -> AuthStatusResponse
    func login(password: String) async throws -> LoginResponse
    func logout() async throws -> LoginResponse
    func beginNativeOIDC(
        callbackURL: URL,
        state: String,
        codeChallenge: String
    ) async throws -> NativeOIDCStartResponse
    func exchangeNativeOIDC(
        flowID: String,
        code: String,
        state: String,
        codeVerifier: String
    ) async throws -> LoginResponse
    func cancelNativeOIDC(flowID: String, state: String) async throws -> LoginResponse
    /// `GET /api/profiles`; native OIDC adopts its `active` profile (TAL-131).
    func profiles() async throws -> ProfilesResponse
}

extension APIClient: AuthAPIClient {}

extension AuthAPIClient {
    func profiles() async throws -> ProfilesResponse {
        throw OIDCSignInError.incompatibleServer
    }

    func beginNativeOIDC(
        callbackURL: URL,
        state: String,
        codeChallenge: String
    ) async throws -> NativeOIDCStartResponse {
        throw OIDCSignInError.incompatibleServer
    }

    func exchangeNativeOIDC(
        flowID: String,
        code: String,
        state: String,
        codeVerifier: String
    ) async throws -> LoginResponse {
        throw OIDCSignInError.incompatibleServer
    }

    func cancelNativeOIDC(flowID: String, state: String) async throws -> LoginResponse {
        throw OIDCSignInError.incompatibleServer
    }
}

public enum OIDCSignInError: LocalizedError, Equatable {
    case alreadyInProgress
    case alreadyConfigured
    case unavailable
    case incompatibleServer
    case invalidAuthorizationURL
    case invalidCallback
    case providerFailed
    case cancelled
    case presentationFailed
    case securityFailure
    case expired
    case replayed
    case profileUnavailable

    public var errorDescription: String? {
        switch self {
        case .alreadyInProgress:
            String(localized: "Another SSO sign-in is already in progress.")
        case .alreadyConfigured:
            String(localized: "This server is already configured.")
        case .unavailable:
            String(localized: "This server doesn't offer single sign-on.")
        case .incompatibleServer:
            String(localized: "This server needs a newer secure SSO handoff before Talaria can sign in.")
        case .invalidAuthorizationURL, .invalidCallback:
            String(localized: "The SSO response didn't match this server. Try signing in again.")
        case .providerFailed:
            String(localized: "The SSO provider couldn't complete sign-in. Try again.")
        case .cancelled:
            String(localized: "SSO sign-in was cancelled.")
        case .presentationFailed:
            String(localized: "Talaria couldn't open the SSO sign-in window. Try again.")
        case .securityFailure:
            String(localized: "Talaria couldn't start a secure SSO flow. Try again.")
        case .expired:
            String(localized: "The SSO sign-in expired. Start again.")
        case .replayed:
            String(localized: "That SSO response was already used. Start again.")
        case .profileUnavailable:
            String(localized: "The server didn't confirm which profile this sign-in uses. Try again.")
        }
    }
}
