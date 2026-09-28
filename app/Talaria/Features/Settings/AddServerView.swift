import SwiftUI
import TalariaKit

struct AddServerView: View {
    @Bindable var authManager: AuthManager
    @Environment(\.dismiss) private var dismiss

    @State private var serverURLString = ""
    @State private var password = ""
    @State private var customHeaders: [CustomHeader] = []
    @State private var needsPassword = false
    @State private var canUseOIDC = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var displayName = ""
    @State private var initials = ""
    @State private var colorHex = HeaderLogoColor.defaultHex

    private var trimmedURL: String {
        serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmit: Bool { !trimmedURL.isEmpty && !isWorking }

    private var derivedHost: String {
        (try? AuthManager.normalizedServerURL(from: serverURLString))?.host ?? ""
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    SettingsCard(title: String(localized: "Server")) {
                        SettingsTextFieldRow(
                            title: String(localized: "URL"),
                            text: $serverURLString,
                            placeholder: "100.64.0.1:8787",
                            keyboardType: .URL,
                            autocapitalization: .never,
                            submitLabel: .go,
                            onSubmit: { Task { await submit() } }
                        )

                        if needsPassword {
                            SettingsDivider()

                            SettingsTextFieldRow(
                                title: String(localized: "Password"),
                                text: $password,
                                placeholder: String(localized: "Server password"),
                                autocapitalization: .never,
                                isSecure: true,
                                submitLabel: .go,
                                onSubmit: { Task { await submit() } }
                            )
                        }

                        if canUseOIDC {
                            SettingsDivider()

                            Button {
                                Task { await submitOIDC() }
                            } label: {
                                Label("Continue with SSO", systemImage: "person.badge.key.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canSubmit)
                        }
                    }

                    SettingsCard(title: String(localized: "Connection Headers")) {
                        CustomHeadersEditor(headers: $customHeaders)
                    }

                    SettingsCard(title: String(localized: "Identity")) {
                        ServerIdentityEditor(
                            displayName: $displayName,
                            initials: $initials,
                            colorHex: $colorHex,
                            fallbackName: derivedHost
                        )
                    }

                    statusBanner
                }
                .padding(.horizontal, 16)
                .padding(.top, 18)
                .padding(.bottom, 36)
            }
            .background(Color(.systemBackground))
            .navigationTitle("Add Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await submit() } }
                        .disabled(!canSubmit)
                }
            }
        }
        .adaptiveFormPresentation()
    }

    @ViewBuilder
    private var statusBanner: some View {
        if isWorking {
            SettingsFootnote(String(localized: "Checking server…"))
        } else if needsPassword, errorMessage == nil {
            SettingsFootnote(String(localized: "This server requires a password."))
        }

        if let errorMessage {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                .font(AppFont.footnote())
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        errorMessage = nil
        isWorking = true
        let outcome = await authManager.addServer(
            serverURLString: serverURLString,
            password: password,
            customHeaders: customHeaders
        )
        isWorking = false

        switch outcome {
        case .needsPassword:
            needsPassword = true
            canUseOIDC = false
        case .needsOIDC:
            needsPassword = false
            canUseOIDC = true
        case .needsPasswordOrOIDC:
            needsPassword = true
            canUseOIDC = true
        case .failed:
            errorMessage = authManager.lastErrorMessage
        case let .added(url):
            finishAdding(url)
        }
    }

    private func submitOIDC() async {
        guard canSubmit else { return }
        errorMessage = nil
        isWorking = true
        let outcome = await authManager.addServerWithOIDC(
            serverURLString: serverURLString,
            customHeaders: customHeaders
        )
        isWorking = false

        if case let .added(url) = outcome {
            finishAdding(url)
        } else {
            errorMessage = authManager.lastErrorMessage
        }
    }

    private func finishAdding(_ url: URL) {
        applyIdentity(to: url)
        dismiss()
    }

    /// Overrides the new server's seeded identity (the registry seeds it from the
    /// previous active server's global defaults) with the add-flow's chosen values.
    private func applyIdentity(to url: URL) {
        guard let account = authManager.servers.first(where: { $0.id == url.absoluteString }) else { return }

        let finalName = displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? (url.host ?? account.displayName)
            : displayName
        let finalInitials = SessionIdentitySettings.displayInitials(
            displayName: finalName,
            storedInitials: initials,
            fallbackFullName: url.host ?? finalName
        )
        authManager.updateServerIdentity(
            account,
            displayName: finalName,
            initials: finalInitials,
            headerLogoColorHex: colorHex
        )
    }
}
