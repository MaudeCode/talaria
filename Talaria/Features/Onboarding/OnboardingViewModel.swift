import Foundation
import Observation

@MainActor
@Observable
final class OnboardingViewModel {
    nonisolated static let emptyPasswordMessage = String(localized: "Enter the server password.")

    var serverURLString = ""
    var password = ""
    var customHeaders: [CustomHeader] = []
    var authStatus: AuthStatusResponse?
    var connectionMessage: String?
    var errorMessage: String?
    var isWorking = false

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
        // No auth → no password. Passkey-only (auth on, password auth explicitly
        // off) → hide the password field; connect() surfaces the unsupported
        // message instead. Unknown (nil) keeps today's "show the field" default.
        guard authStatus?.authEnabled != false else { return false }
        return authStatus?.passwordAuthEnabled != false
    }

    func testConnection(authManager: AuthManager) async {
        errorMessage = nil
        connectionMessage = nil
        isWorking = true
        defer { isWorking = false }

        do {
            let status = try await authManager.testConnection(
                serverURLString: serverURLString,
                customHeaders: customHeaders
            )
            authStatus = status
            if status.authEnabled == true, status.passwordAuthEnabled == false {
                errorMessage = AuthManager.passkeyOnlyMessage
            } else {
                connectionMessage = status.authEnabled == true
                    ? String(localized: "Connection ok. Password required.")
                    : String(localized: "Connection ok. Password not required.")
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func connect(authManager: AuthManager) async {
        errorMessage = nil
        connectionMessage = nil

        if let validationMessage = Self.passwordValidationMessage(authStatus: authStatus, password: password) {
            errorMessage = validationMessage
            return
        }

        isWorking = true
        defer { isWorking = false }

        if authStatus == nil {
            do {
                authStatus = try await authManager.testConnection(
                    serverURLString: serverURLString,
                    customHeaders: customHeaders
                )
            } catch {
                errorMessage = error.localizedDescription
                return
            }

            if let validationMessage = Self.passwordValidationMessage(authStatus: authStatus, password: password) {
                errorMessage = validationMessage
                return
            }
        }

        await authManager.configure(
            serverURLString: serverURLString,
            password: password,
            customHeaders: customHeaders
        )
        errorMessage = authManager.lastErrorMessage
    }

    nonisolated static func passwordValidationMessage(authStatus: AuthStatusResponse?, password: String) -> String? {
        guard authStatus?.authEnabled == true else { return nil }
        // Passkey-only servers don't take a password — let configure() report the
        // specific unsupported message instead of demanding one here (#255).
        guard authStatus?.passwordAuthEnabled != false else { return nil }

        let trimmedPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedPassword.isEmpty ? emptyPasswordMessage : nil
    }
}
