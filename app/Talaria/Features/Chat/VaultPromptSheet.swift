import SwiftUI
import TalariaKit

/// The Agent asks for a password manager's master password, a login to save, a one-time code (TAL-887), or a skill's
/// missing environment secret (TAL-1046). Every field comes from the server's `vault` prompt; the typed values live
/// only in this view until they are sent.
struct VaultPromptSheet: View {
    let vault: VaultPrompt
    let isResponding: Bool
    let errorMessage: String?
    /// The typed values keyed by field, or `nil` to decline.
    let onRespond: ([String: String]?) -> Void

    @State private var values: [VaultPrompt.Field.Key: String] = [:]
    @FocusState private var focused: VaultPrompt.Field.Key?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(vault.fields) { field in
                        input(field)
                    }
                } header: {
                    if vault.kind != .unlock, let site = vault.site {
                        Text(site)
                            .textCase(nil)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let hint = vault.hint, !hint.isEmpty {
                            Text(hint)
                        }
                        if let help = vault.skill?.help, !help.isEmpty {
                            Text(help)
                                .textSelection(.enabled)
                        }
                        if let requiredFor = vault.skill?.requiredFor, !requiredFor.isEmpty {
                            Text("Required for \(requiredFor)")
                        }
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            let seconds = Int(max(0, vault.timeoutAt - context.date.timeIntervalSince1970).rounded(.up))
                            Text("\(String(seconds))s left")
                                .monospacedDigit()
                        }
                    }
                }
                if let errorMessage, !errorMessage.isEmpty {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Skip") { send(nil) }
                        .disabled(isResponding)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitTitle) { send(answers) }
                        .disabled(isResponding || !isComplete)
                        .accessibilityIdentifier("vault-prompt-submit")
                }
            }
            .onAppear { focused = vault.fields.first?.key }
        }
        .interactiveDismissDisabled()
    }

    @ViewBuilder
    private func input(_ field: VaultPrompt.Field) -> some View {
        let text = Binding(get: { values[field.key] ?? "" }, set: { values[field.key] = $0 })
        Group {
            // The answers are for another site or a password manager: AutoFill offers nothing iOS keeps for Talaria
            // itself, only a code read from the message the site sent. Codes can have letters.
            if field.secure {
                SecureField(label(field.key), text: text)
                    .textContentType(nil)
            } else {
                TextField(label(field.key), text: text)
                    .textContentType(field.key == .code ? .oneTimeCode : nil)
                    .keyboardType(field.key == .code ? .asciiCapable : .emailAddress)
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($focused, equals: field.key)
        .disabled(isResponding)
        .accessibilityIdentifier("vault-prompt-\(field.key.rawValue)")
    }

    private var answers: [String: String] {
        Dictionary(uniqueKeysWithValues: vault.fields.map { ($0.key.rawValue, values[$0.key] ?? "") })
    }

    private var isComplete: Bool {
        vault.fields.allSatisfy { !(values[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func send(_ answers: [String: String]?) {
        values = [:]
        onRespond(answers)
    }

    private var title: String {
        switch vault.kind {
        case .unlock: String(localized: "Unlock \(vault.displayName ?? vault.backend ?? "")")
        case .saveLogin: String(localized: "Save Login")
        case .code: String(localized: "Verification Code")
        case .skillSecret: String(localized: "Set Up \(vault.skill?.skillName ?? "")")
        }
    }

    private var submitTitle: String {
        switch vault.kind {
        case .unlock: String(localized: "Unlock")
        case .saveLogin, .skillSecret: String(localized: "Save")
        case .code: String(localized: "Enter")
        }
    }

    private func label(_ key: VaultPrompt.Field.Key) -> String {
        switch key {
        case .masterPassword: String(localized: "Master Password")
        case .identifier: String(localized: "Email or Username")
        case .password: String(localized: "Password")
        case .code: String(localized: "Code")
        case .secret: vault.skill.map(\.envVar).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Secret")
        }
    }
}
