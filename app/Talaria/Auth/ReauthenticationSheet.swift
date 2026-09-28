import SwiftUI
import TalariaKit

struct ReauthenticationSheet: View {
    @Bindable var authManager: AuthManager
    let server: URL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage(PrimaryActionTintSettings.isEnabledKey) private var tintsPrimaryActions = false
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex
    @State private var prefersPassword = false
    @State private var password = ""
    @State private var isWorking = false
    @State private var customHeaders: [CustomHeader]

    init(authManager: AuthManager, server: URL) {
        self.authManager = authManager
        self.server = server
        _customHeaders = State(initialValue: authManager.currentCustomHeaders)
    }

    private var serverName: String {
        let name = authManager.servers.first { $0.id == server.absoluteString }?
            .displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? serverHost : name
    }

    private var serverHost: String {
        let host = server.host ?? server.absoluteString
        return server.port.map { "\(host):\($0)" } ?? host
    }

    private var needsHeaderRecovery: Bool {
        !authManager.reauthenticationOffersSSO && !authManager.reauthenticationOffersPassword
    }

    private var usesSSO: Bool {
        authManager.reauthenticationOffersSSO && !prefersPassword
    }

    private var showsPassword: Bool {
        authManager.reauthenticationOffersPassword && !usesSSO
    }

    private var isPasswordMissing: Bool {
        showsPassword && password.isEmpty
    }

    private var primaryTitle: String {
        if usesSSO { return String(localized: "Continue with SSO") }
        return needsHeaderRecovery ? String(localized: "Try Again") : String(localized: "Sign In")
    }

    private var primaryIdentifier: String {
        if usesSSO { return "ReauthenticateSSO" }
        return needsHeaderRecovery ? "ReauthenticateRetry" : "ReauthenticateSignIn"
    }

    private var actionTint: Color {
        tintsPrimaryActions ? HeaderLogoColor.color(for: headerLogoColorHex) : Color(.label)
    }

    private var actionForeground: Color {
        guard tintsPrimaryActions else { return Color(.systemBackground) }
        return HeaderLogoColor.prefersDarkForeground(for: headerLogoColorHex) ? .black : .white
    }

    private var compactHeight: CGFloat {
        if needsHeaderRecovery { return 420 }
        let hasMethodSwitch = authManager.reauthenticationOffersSSO && authManager.reauthenticationOffersPassword
        return (showsPassword ? 360 : 300) + (hasMethodSwitch ? 44 : 0)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Sign In")
                        .font(AppFont.title2(weight: .semibold))
                        .accessibilityAddTraits(.isHeader)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(serverName).font(AppFont.callout(weight: .medium))
                        if serverName != serverHost {
                            Text(serverHost).font(AppFont.footnote()).foregroundStyle(.secondary)
                        }
                    }
                    Text("Your session expired. Sign in again.")
                        .font(AppFont.subheadline())
                        .foregroundStyle(.secondary)
                }

                if showsPassword {
                    HStack(spacing: 10) {
                        Image(systemName: "key.fill")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        SecureField("Password", text: $password)
                            .font(AppFont.body())
                            .textContentType(.password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .onSubmit { if !password.isEmpty { signIn(usingSSO: false) } }
                            .accessibilityIdentifier("ReauthenticatePassword")
                    }
                    .padding(16)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }

                if isWorking {
                    ProgressView(String(localized: "Checking server…"))
                        .font(AppFont.footnote())
                } else if let error = authManager.lastErrorMessage {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(AppFont.footnote())
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if needsHeaderRecovery {
                    DisclosureGroup("Connection Headers") {
                        CustomHeadersEditor(headers: $customHeaders)
                            .padding(.top, 12)
                    }
                    .font(AppFont.subheadline())
                    .tint(.primary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 28)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 12)
                .background(Color(.systemBackground))
        }
        .background(Color(.systemBackground))
        .disabled(isWorking)
        .interactiveDismissDisabled()
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.height(compactHeight), .large])
        .presentationDragIndicator(.visible)
    }

    private var actions: some View {
        VStack(spacing: 10) {
            HapticButton { signIn(usingSSO: usesSSO) } label: {
                Text(primaryTitle)
                    .font(AppFont.body(weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(isPasswordMissing ? Color(.systemGray5) : actionTint)
            .foregroundStyle(isPasswordMissing ? Color(.secondaryLabel) : actionForeground)
            .disabled(isPasswordMissing)
            .accessibilityIdentifier(primaryIdentifier)

            if authManager.reauthenticationOffersSSO && authManager.reauthenticationOffersPassword {
                Button {
                    prefersPassword.toggle()
                } label: {
                    Text(usesSSO ? String(localized: "Sign in with password") : String(localized: "Use SSO instead"))
                        .underline()
                        .frame(minHeight: 44)
                }
                .font(AppFont.subheadline())
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("ReauthenticateSwitchMethod")
            }

            HStack(spacing: 24) {
                if authManager.servers.count > 1 {
                    Menu("Switch Server") {
                        ForEach(authManager.servers.filter { $0.id != server.absoluteString }) { account in
                            Button(account.displayName) { authManager.switchActiveServer(to: account) }
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                Button("Sign Out", role: .destructive) {
                    isWorking = true
                    Task {
                        await authManager.signOut()
                        isWorking = false
                    }
                }
            }
            .font(AppFont.footnote(weight: .medium))
            .buttonStyle(.plain)
            .frame(minHeight: 44)
        }
    }

    private func signIn(usingSSO: Bool) {
        guard !isWorking else { return }
        let headers = customHeaders
        isWorking = true
        Task {
            let canCommit = { @MainActor in authManager.pendingReauthentication == server }
            if usingSSO {
                await authManager.configureWithOIDC(serverURLString: server.absoluteString, customHeaders: headers, canCommit: canCommit)
            } else {
                await authManager.configure(serverURLString: server.absoluteString, password: password, customHeaders: headers, canCommit: canCommit)
            }
            isWorking = false
        }
    }
}
