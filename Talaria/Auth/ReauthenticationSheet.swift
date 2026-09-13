import SwiftUI

struct ReauthenticationSheet: View {
    @Bindable var authManager: AuthManager
    let server: URL
    @State private var password = ""
    @State private var isWorking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(authManager.servers.first { $0.id == server.absoluteString }?.displayName ?? server.host ?? "")
                            .font(.headline)
                        Text(server.absoluteString)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text("Your session expired. Sign in again.")
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    if authManager.reauthenticationOffersSSO {
                        Button("Continue with SSO") { signIn(usingSSO: true) }
                            .accessibilityIdentifier("ReauthenticateSSO")
                    }
                    if authManager.reauthenticationOffersPassword {
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .submitLabel(.go)
                            .onSubmit { if !password.isEmpty { signIn(usingSSO: false) } }
                            .accessibilityIdentifier("ReauthenticatePassword")
                        Button("Sign In") { signIn(usingSSO: false) }
                            .disabled(password.isEmpty)
                            .accessibilityIdentifier("ReauthenticateSignIn")
                    }
                    if isWorking { ProgressView() }
                    if let error = authManager.lastErrorMessage {
                        Text(error).foregroundStyle(.red)
                    }
                }
                Section {
                    if authManager.servers.count > 1 {
                        Menu("Switch Server") {
                            ForEach(authManager.servers.filter { $0.id != server.absoluteString }) { account in
                                Button(account.displayName) { authManager.switchActiveServer(to: account) }
                            }
                        }
                    }
                    Button("Sign Out", role: .destructive) {
                        isWorking = true
                        Task {
                            await authManager.signOut()
                            isWorking = false
                        }
                    }
                }
            }
            .disabled(isWorking)
            .navigationTitle("Sign In")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("ReauthenticationSheet")
    }

    private func signIn(usingSSO: Bool) {
        guard !isWorking else { return }
        isWorking = true
        Task {
            let canCommit = { @MainActor in authManager.pendingReauthentication == server }
            if usingSSO {
                await authManager.configureWithOIDC(serverURLString: server.absoluteString, canCommit: canCommit)
            } else {
                await authManager.configure(serverURLString: server.absoluteString, password: password, canCommit: canCommit)
            }
            isWorking = false
        }
    }
}
