import Foundation

public struct HealthResponse: Decodable {
    public let status: String?
    let sessions: Int?
    let activeStreams: Int?
    let uptimeSeconds: Double?
}

public struct AuthStatusResponse: Decodable {
    public let authEnabled: Bool?
    public let loggedIn: Bool?
    /// Finer-grained capabilities newer servers report. All optional so older
    /// servers that omit them decode unchanged. `password_auth_enabled == false`
    /// (and only an explicit false) marks a passkey-only server we can't sign
    /// into yet (#255); a missing value means "unknown" → treat as today.
    public let passwordAuthEnabled: Bool?
    let passkeysEnabled: Bool?
    let passwordlessEnabled: Bool?
    /// Set when the server offers single sign-on. `is_auth_enabled()` upstream
    /// covers password, OIDC *and* trusted-header, so "auth on, password off"
    /// on its own never meant passkeys.
    public let oidcEnabled: Bool?
    /// A newer OIDC server can exchange a system-browser login for the normal
    /// HttpOnly WebUI session cookie without placing that cookie in a callback.
    public let oidcNativeHandoffEnabled: Bool?
    /// The server may use single sign-on but cannot read its SSO settings yet,
    /// so it withholds SSO while sign-in stays required.
    public let oidcUnavailable: Bool?
    /// Set when an identity proxy in front of the server authenticates the
    /// request (Cloudflare Access, Authentik). Present only when that mode is
    /// on, so nil means "not that kind of server".
    public let trustedAuthEnabled: Bool?

    /// The server already considers this client signed in. Trusted-header
    /// deployments authenticate at the proxy, so there is no credential for the
    /// app to send and no login step to perform.
    public var isAlreadySignedIn: Bool { loggedIn == true }

    init(
        authEnabled: Bool? = nil,
        loggedIn: Bool? = nil,
        passwordAuthEnabled: Bool? = nil,
        passkeysEnabled: Bool? = nil,
        passwordlessEnabled: Bool? = nil,
        oidcEnabled: Bool? = nil,
        oidcNativeHandoffEnabled: Bool? = nil,
        oidcUnavailable: Bool? = nil,
        trustedAuthEnabled: Bool? = nil
    ) {
        self.authEnabled = authEnabled
        self.loggedIn = loggedIn
        self.passwordAuthEnabled = passwordAuthEnabled
        self.passkeysEnabled = passkeysEnabled
        self.passwordlessEnabled = passwordlessEnabled
        self.oidcEnabled = oidcEnabled
        self.oidcNativeHandoffEnabled = oidcNativeHandoffEnabled
        self.oidcUnavailable = oidcUnavailable
        self.trustedAuthEnabled = trustedAuthEnabled
    }
}

public struct NativeOIDCStartResponse: Decodable {
    public let flowId: String
    public let authorizationUrl: URL
    public let serverId: String
    public let expiresIn: Int
}

public struct LoginResponse: Decodable {
    public let ok: Bool?
    let message: String?
    let error: String?
}
