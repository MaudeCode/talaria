import SwiftUI
import TalariaKit

struct ServerDetailView: View {
    @Bindable var authManager: AuthManager
    let account: ServerAccount

    @Environment(\.dismiss) private var dismiss
    @State private var displayName: String
    @State private var initials: String
    @State private var colorHex: String
    @State private var isConfirmingRemove = false
    @State private var isRemoving = false
    @State private var errorMessage: String?

    init(authManager: AuthManager, account: ServerAccount) {
        self.authManager = authManager
        self.account = account
        _displayName = State(initialValue: account.displayName)
        _initials = State(initialValue: account.initials)
        _colorHex = State(initialValue: account.headerLogoColorHex)
    }

    private var isActive: Bool { account.id == authManager.activeServerID }
    private var hasOtherServers: Bool { authManager.servers.count > 1 }
    private var hostFallback: String { URL(string: account.urlString)?.host ?? account.urlString }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                SettingsCard(title: String(localized: "Server")) {
                    SettingsInfoRow(title: String(localized: "URL"), value: account.urlString, valueIsSelectable: true)

                    SettingsDivider()

                    SettingsValueRow(title: String(localized: "Status")) {
                        SettingsStatusPill(label: isActive ? String(localized: "Active") : String(localized: "Inactive"))
                    }
                }

                SettingsCard(title: String(localized: "Identity")) {
                    ServerIdentityEditor(
                        displayName: $displayName,
                        initials: $initials,
                        colorHex: $colorHex,
                        fallbackName: hostFallback
                    )

                    IdentitySaveErrorNotice(authManager: authManager)
                }

                if !isActive {
                    SettingsCard(title: String(localized: "Active Server")) {
                        SettingsFootnote(String(localized: "Makes this the active server. Sessions, chats, and settings reload for it."))

                        SettingsButton(String(localized: "Switch to This Server")) {
                            authManager.switchActiveServer(to: account)
                        }
                    }
                }

                SettingsCard(title: isActive ? String(localized: "Account") : String(localized: "Remove Server")) {
                    SettingsFootnote(removeFootnote)

                    SettingsButton(removeButtonTitle, role: .destructive, isLoading: isRemoving) {
                        isConfirmingRemove = true
                    }
                    .disabled(isRemoving)
                }

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(AppFont.footnote())
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 36)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(displayName.isEmpty ? hostFallback : displayName)
        .navigationBarTitleDisplayMode(.inline)
        // Stage identity edits for this server's registry entry; the manager
        // previews the active server's avatar / header tint live (#17) and
        // saves once typing pauses or this view goes away (TAL-123).
        .onChange(of: displayName) { persistIdentity() }
        .onChange(of: initials) { persistIdentity() }
        .onChange(of: colorHex) { persistIdentity() }
        .onDisappear { authManager.flushServerIdentityEdits() }
        .alert(removeAlertTitle, isPresented: $isConfirmingRemove) {
            Button("Cancel", role: .cancel) {}
            Button(removeButtonTitle, role: .destructive) {
                Task {
                    let wasActive = isActive
                    isRemoving = true
                    errorMessage = nil
                    guard await authManager.removeServer(account) else {
                        errorMessage = authManager.lastErrorMessage
                        isRemoving = false
                        return
                    }
                    // Only a non-active removal leaves this view alive to reset its
                    // state and pop; the active-server case is already torn down.
                    if !wasActive {
                        isRemoving = false
                        dismiss()
                    }
                }
            }
        } message: {
            Text(removeAlertMessage)
        }
    }

    private func persistIdentity() {
        authManager.updateServerIdentity(
            account,
            displayName: displayName,
            initials: initials,
            headerLogoColorHex: colorHex
        )
    }

    private var removeButtonTitle: String {
        isActive ? String(localized: "Sign Out of This Server") : String(localized: "Remove Server")
    }

    private var removeAlertTitle: String {
        isActive ? String(localized: "Sign out of this server?") : String(localized: "Remove this server?")
    }

    private var removeFootnote: String {
        if isActive {
            return hasOtherServers
                ? String(localized: "Signs out and switches to another configured server.")
                : String(localized: "Signs out and returns to onboarding.")
        }
        return String(localized: "Removes this server and its saved settings on this device. Your active server is unaffected.")
    }

    private var removeAlertMessage: String {
        if isActive {
            return hasOtherServers
                ? String(localized: "You'll switch to another configured server. Sign in again to use this one.")
                : String(localized: "You'll return to onboarding and need the server URL and password to sign back in.")
        }
        return String(localized: "This removes the server and its saved settings on this device. Your active server is unaffected.")
    }
}
