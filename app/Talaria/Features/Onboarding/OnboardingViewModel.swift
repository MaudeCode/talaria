import Foundation
import Observation
import TalariaKit

@MainActor
@Observable
final class OnboardingViewModel {
    nonisolated static let emptyPasswordMessage = String(localized: "Enter the server password.")

    var serverURLString = "" {
        didSet { if serverURLString != oldValue { invalidateConnectionState() } }
    }
    var password = "" {
        didSet { if password != oldValue { invalidateConnectionState() } }
    }
    var customHeaders: [CustomHeader] = [] {
        didSet { if customHeaders != oldValue { invalidateConnectionState() } }
    }
    var authStatus: AuthStatusResponse?
    var connectionMessage: String?
    var errorMessage: String?
    var isWorking = false
    private var connectionInputRevision = 0

    init(
        savedServer: URL? = nil,
        savedHeaders: [CustomHeader] = [],
        initialErrorMessage: String? = nil
    ) {
        if let savedServer {
            serverURLString = savedServer.absoluteString
        }
        customHeaders = savedHeaders
        errorMessage = initialErrorMessage
    }

    var isPasswordRequired: Bool {
        // No auth → no password. Already signed in (trusted-header proxy) → no
        // password either. Passkey/OIDC-only → hide the field. Unknown (nil)
        // keeps today's "show the field" default.
        guard authStatus?.authEnabled != false else { return false }
        guard authStatus?.isAlreadySignedIn != true else { return false }
        return authStatus?.passwordAuthEnabled != false
    }

    var canSignInWithOIDC: Bool { Self.canSignInWithOIDC(status: authStatus) }

    nonisolated static func canSignInWithOIDC(status: AuthStatusResponse?) -> Bool {
        status?.oidcEnabled == true
            && status?.oidcNativeHandoffEnabled == true
            && status?.isAlreadySignedIn != true
    }

    func testConnection(authManager: AuthManager) async {
        let revision = connectionInputRevision
        let serverURLString = serverURLString
        let customHeaders = customHeaders
        errorMessage = nil
        connectionMessage = nil
        isWorking = true
        defer {
            if revision == connectionInputRevision {
                isWorking = false
            }
        }

        do {
            let status = try await authManager.testConnection(
                serverURLString: serverURLString,
                customHeaders: customHeaders
            )
            guard revision == connectionInputRevision else { return }
            authStatus = status
            if let message = AuthManager.unsupportedSignInMessage(for: status) {
                errorMessage = message
            } else if status.isAlreadySignedIn {
                connectionMessage = String(localized: "Connection ok. Already signed in by this server.")
            } else if Self.canSignInWithOIDC(status: status) {
                connectionMessage = status.passwordAuthEnabled == true
                    ? String(localized: "Connection ok. Password or SSO available.")
                    : String(localized: "Connection ok. Continue with SSO.")
            } else {
                connectionMessage = status.authEnabled == true
                    ? String(localized: "Connection ok. Password required.")
                    : String(localized: "Connection ok. Password not required.")
            }
        } catch {
            guard revision == connectionInputRevision else { return }
            errorMessage = error.localizedDescription
        }
    }

    func connect(authManager: AuthManager) async {
        let revision = connectionInputRevision
        let serverURLString = serverURLString
        let password = password
        let customHeaders = customHeaders
        errorMessage = nil
        connectionMessage = nil

        if let validationMessage = Self.passwordValidationMessage(authStatus: authStatus, password: password) {
            errorMessage = validationMessage
            return
        }

        isWorking = true
        defer {
            if revision == connectionInputRevision {
                isWorking = false
            }
        }

        if authStatus == nil {
            do {
                let status = try await authManager.testConnection(
                    serverURLString: serverURLString,
                    customHeaders: customHeaders
                )
                guard revision == connectionInputRevision else { return }
                authStatus = status
            } catch {
                guard revision == connectionInputRevision else { return }
                errorMessage = error.localizedDescription
                return
            }

            if let validationMessage = Self.passwordValidationMessage(authStatus: authStatus, password: password) {
                errorMessage = validationMessage
                return
            }
        }

        if Self.canSignInWithOIDC(status: authStatus),
           authStatus?.passwordAuthEnabled == false {
            await authManager.configureWithOIDC(
                serverURLString: serverURLString,
                customHeaders: customHeaders,
                canCommit: { revision == self.connectionInputRevision }
            )
            guard revision == connectionInputRevision else { return }
            errorMessage = authManager.lastErrorMessage
            return
        }

        await authManager.configure(
            serverURLString: serverURLString,
            password: password,
            customHeaders: customHeaders,
            canCommit: { revision == self.connectionInputRevision }
        )
        guard revision == connectionInputRevision else { return }
        errorMessage = authManager.lastErrorMessage
    }

    func signInWithOIDC(authManager: AuthManager) async {
        let revision = connectionInputRevision
        let serverURLString = serverURLString
        let customHeaders = customHeaders
        errorMessage = nil
        connectionMessage = nil
        isWorking = true
        defer {
            if revision == connectionInputRevision {
                isWorking = false
            }
        }

        await authManager.configureWithOIDC(
            serverURLString: serverURLString,
            customHeaders: customHeaders,
            canCommit: { revision == self.connectionInputRevision }
        )
        guard revision == connectionInputRevision else { return }
        errorMessage = authManager.lastErrorMessage
    }

    private func invalidateConnectionState() {
        connectionInputRevision &+= 1
        authStatus = nil
        connectionMessage = nil
        errorMessage = nil
        isWorking = false
    }

    nonisolated static func passwordValidationMessage(authStatus: AuthStatusResponse?, password: String) -> String? {
        guard authStatus?.authEnabled == true else { return nil }
        // A server that already signed this client in (trusted-header proxy)
        // has no password to demand.
        guard authStatus?.isAlreadySignedIn != true else { return nil }
        // Passkey/OIDC-only servers don't take a password.
        guard authStatus?.passwordAuthEnabled != false else { return nil }

        let trimmedPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedPassword.isEmpty ? emptyPasswordMessage : nil
    }
}
