import Foundation

struct HealthResponse: Decodable {
    let status: String?
    let sessions: Int?
    let activeStreams: Int?
    let uptimeSeconds: Double?
}

struct AuthStatusResponse: Decodable {
    let authEnabled: Bool?
    let loggedIn: Bool?
    /// Finer-grained capabilities newer servers report. All optional so older
    /// servers that omit them decode unchanged. `password_auth_enabled == false`
    /// (and only an explicit false) marks a passkey-only server we can't sign
    /// into yet (#255); a missing value means "unknown" → treat as today.
    let passwordAuthEnabled: Bool?
    let passkeysEnabled: Bool?
    let passwordlessEnabled: Bool?

    init(
        authEnabled: Bool? = nil,
        loggedIn: Bool? = nil,
        passwordAuthEnabled: Bool? = nil,
        passkeysEnabled: Bool? = nil,
        passwordlessEnabled: Bool? = nil
    ) {
        self.authEnabled = authEnabled
        self.loggedIn = loggedIn
        self.passwordAuthEnabled = passwordAuthEnabled
        self.passkeysEnabled = passkeysEnabled
        self.passwordlessEnabled = passwordlessEnabled
    }
}

struct LoginResponse: Decodable {
    let ok: Bool?
    let message: String?
    let error: String?
}
