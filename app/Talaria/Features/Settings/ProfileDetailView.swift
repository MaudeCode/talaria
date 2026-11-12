import SwiftUI
import TalariaKit

/// Extends the SettingsCategoryPage pattern with the selected profile's shared rows.
struct ProfileDetailView: View {
    let server: URL
    let name: String
    let model: ProfilesSettingsModel
    let use: (ProfileSummary, Bool) -> Void
    let missing: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var deleting = false
    @State private var isLeaving = false

    private var profile: ProfileSummary? { model.profiles.first { $0.name == name } }

    var body: some View {
        ServerSettingsScope(server: server) { store in
            SettingsPage(title: profile?.displayName ?? name) {
                if let profile {
                    SettingsSection(title: String(localized: "Identity")) {
                        value("Display Name", profile.botDisplayName, "display-name")
                        value("Name", profile.name, "name")
                        value("Description", profile.description, "description")
                        if profile.isDefault == true, let botName = store.settings?.botName {
                            SettingsTextFieldRow(title: String(localized: "Assistant Name"),
                                                 text: Binding(get: { store.settings?.botName ?? botName },
                                                               set: { store.setBotName($0) }),
                                                 placeholder: "Hermes")
                                .accessibilityIdentifier("settings-profile-detail-assistant-name")
                        }
                    }
                    if profile.model != nil || profile.provider != nil {
                        SettingsSection(title: String(localized: "Model")) {
                            value("Default Model", profile.model, "model")
                            value("Provider", profile.provider, "provider")
                        }
                    }
                    if profile.gatewayMode != nil || profile.formattedSkills != nil || profile.hasEnv != nil
                        || (profile.pendingWrites ?? 0) > 0 {
                        SettingsSection(title: String(localized: "Agent")) {
                            value("Gateway Mode", profile.gatewayMode?.title, "gateway-mode")
                            value("Skills", profile.formattedSkills, "skills")
                            if let configured = profile.hasEnv {
                                value("API Keys", configured ? String(localized: "Configured") : String(localized: "Not configured"), "api-keys")
                            }
                            if let pending = profile.pendingWrites, pending > 0 {
                                value("Pending Writes", pending.formatted(), "pending-writes")
                            }
                        }
                    }
                    if let path = profile.path {
                        SettingsSection(title: String(localized: "Location")) {
                            SettingsInfoRow(title: String(localized: "Path"), value: path, valueIsSelectable: true)
                                .accessibilityIdentifier("settings-profile-detail-path")
                        }
                    }
                    if let error = model.errorMessage ?? store.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
                    if model.canDelete(profile) {
                        SettingsButton(String(localized: "Delete Profile"), role: .destructive) { deleting = true }
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let profile {
                    if !model.isSingleProfileMode {
                        ToolbarItem(placement: .primaryAction) {
                            Button("Edit", systemImage: "pencil") { editing = true }
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Menu("Actions", systemImage: "ellipsis") {
                            ProfileActions(profile: profile, canDelete: model.canDelete(profile), use: use, delete: { deleting = true })
                        }
                    }
                }
            }
            .sheet(isPresented: $editing) {
                if let profile { EditProfileSheet(profile: profile, model: model) }
            }
            .confirmationDialog(String(localized: "Delete \(profile?.displayName ?? name)?"), isPresented: $deleting,
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    guard let profile else { return }
                    returnToList(reportMissing: false)
                    model.delete(profile)
                }
            }
            .onChange(of: profile == nil) { _, absent in
                if absent { returnToList(reportMissing: true) }
            }
            .task { if profile == nil { returnToList(reportMissing: true) } }
        }
    }

    private func returnToList(reportMissing: Bool) {
        guard !isLeaving else { return }
        isLeaving = true
        if reportMissing { missing() }
        dismiss()
    }

    @ViewBuilder
    private func value(_ title: LocalizedStringResource, _ text: String?, _ field: String) -> some View {
        if let text {
            SettingsInfoRow(title: String(localized: title), value: text)
                .accessibilityIdentifier("settings-profile-detail-\(field)")
        }
    }
}

/// The same actions own the list's swipe/context menus and the detail toolbar.
struct ProfileActions: View {
    let profile: ProfileSummary
    let canDelete: Bool
    let use: (ProfileSummary, Bool) -> Void
    let delete: () -> Void

    var body: some View {
        Button("Use This Profile", systemImage: "arrow.left.arrow.right") { use(profile, false) }
        if profile.canonicalSession != nil {
            Button("Open Bot Chat", systemImage: "arrow.up.right") { use(profile, true) }
                .accessibilityIdentifier("profile-open-bot-chat-\(profile.name ?? "")")
        }
        if canDelete { Button("Delete", systemImage: "trash", role: .destructive, action: delete) }
    }
}

/// CreateProfileSheet owns creation and credentials; this editor only patches existing identity.
struct EditProfileSheet: View {
    let profile: ProfileSummary
    let model: ProfilesSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var displayName: String
    @State private var description: String

    init(profile: ProfileSummary, model: ProfilesSettingsModel) {
        self.profile = profile
        self.model = model
        _displayName = State(initialValue: profile.botDisplayName ?? "")
        _description = State(initialValue: profile.description ?? "")
    }

    var body: some View {
        NavigationStack {
            SettingsPage(title: String(localized: "Edit Profile")) {
                SettingsSection(title: String(localized: "Identity"), help: profile.displayNameOverridden == true
                                ? String(localized: "Bot Mode's title is shown instead.") : nil) {
                    SettingsTextFieldRow(title: String(localized: "Display Name"), text: $displayName, placeholder: profile.name ?? "")
                        .disabled(profile.displayNameOverridden == true)
                        .accessibilityIdentifier("settings-profile-edit-name")
                    SettingsTextFieldRow(title: String(localized: "Description"), text: $description, placeholder: "")
                        .accessibilityIdentifier("settings-profile-edit-description")
                }
            }
            .onChange(of: displayName) { _, value in displayName = ProfileNameRules.boundedIdentityText(value, limit: ProfileNameRules.displayNameLimit) }
            .onChange(of: description) { _, value in description = ProfileNameRules.boundedIdentityText(value, limit: ProfileNameRules.descriptionLimit) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        model.edit(profile, displayName: displayName, description: description)
                        dismiss()
                    }
                }
            }
        }
    }
}
