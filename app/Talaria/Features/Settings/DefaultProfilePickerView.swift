import SwiftUI
import TalariaKit

struct DefaultProfileSelection: Equatable {
    let name: String
    let displayName: String
    let defaultModel: String?
}

struct DefaultProfilePickerView: View {
    let server: URL
    let currentDefaultProfileName: String?
    let onSave: (DefaultProfileSelection) -> Void

    @Environment(\.openURL) private var openURL
    @State private var model: ProfilesSettingsModel
    @State private var searchText = ""
    @State private var showsCreateProfile = false
    @State private var deleting: ProfileSummary?

    init(server: URL, currentDefaultProfileName: String?, onSave: @escaping (DefaultProfileSelection) -> Void) {
        self.server = server
        self.currentDefaultProfileName = currentDefaultProfileName
        self.onSave = onSave
        _model = State(initialValue: ProfilesSettingsModel(client: APIClient(baseURL: server)))
    }

    var body: some View {
        SettingsPage(title: String(localized: "Profiles"), indexPage: .category(.profiles)) {
            SettingsPickerSearchField(text: $searchText, prompt: "Search profiles", clearLabel: "Clear profile search")
            if let error = model.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
            if model.isLoading && model.profiles.isEmpty {
                ProgressView("Loading profiles...")
            } else if model.profiles.isEmpty && model.errorMessage != nil {
                Label("Could Not Load Profiles", systemImage: "exclamationmark.triangle")
            } else {
                SettingsSection(title: String(localized: "Profiles")) {
                    ForEach(filteredProfiles, id: \.name) { profile in
                        NavigationLink {
                            ProfileDetailView(server: server, name: profile.name ?? "", model: model,
                                              use: { save($0, openBotChat: $1) },
                                              missing: { model.errorMessage = String(localized: "This profile no longer exists.") })
                        } label: {
                            SettingsItemRow(title: profile.displayName, subtitle: profileDetails(profile),
                                            accessibilityIdentifier: "settings-profile-row-\(profile.name ?? "")",
                                            accessorySystemImage: "chevron.forward") {
                                Image(systemName: "person.crop.circle").accessibilityHidden(true)
                            } badges: {
                                if profile.isDefault == true { ProfileStatusBadge(title: String(localized: "Default")) }
                                if profile.name == model.activeName { ProfileStatusBadge(title: String(localized: "Active")) }
                            }
                        }
                        .contextMenu { profileActions(profile) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) { profileActions(profile) }
                    }
                    if filteredProfiles.isEmpty { Text("No Matching Profiles").foregroundStyle(.secondary) }
                }
            }
            if !model.isSingleProfileMode {
                Button { showsCreateProfile = true } label: {
                    SettingsItemRow(title: SettingsIndex.profilesNewProfile.title) {
                        Image(systemName: "plus.circle").accessibilityHidden(true)
                    }
                    .sidebarRowPadding()
                }
                .buttonStyle(.plain)
                .sidebarRow(isSelected: false)
                .accessibilityHint("Opens the new profile form.")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshesLive(showsStatus: !model.profiles.isEmpty) { await model.load() }
        .sheet(isPresented: $showsCreateProfile) {
            CreateProfileSheet(server: server) { profile in
                if let profile { model.appendCreated(profile) }
                Task { await model.load() }
            }
        }
        .confirmationDialog(String(localized: "Delete \(deleting?.displayName ?? "")?"),
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { profile in
            Button("Delete", role: .destructive) { model.delete(profile); deleting = nil }
        }
    }

    private var filteredProfiles: [ProfileSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.profiles }
        return model.profiles.filter { profile in
            [profile.displayName, profile.name, profile.model, profile.provider]
                .compactMap { $0 }.contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    private func profileDetails(_ profile: ProfileSummary) -> String? {
        var parts = [profile.model, profile.gatewayMode?.title].compactMap { $0 }
        if let skills = profile.formattedSkills { parts.append(skills) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func profileActions(_ profile: ProfileSummary) -> some View {
        ProfileActions(profile: profile, canDelete: model.canDelete(profile),
                       use: { save($0, openBotChat: $1) }, delete: { deleting = profile })
    }

    private func save(_ profile: ProfileSummary, openBotChat: Bool) {
        model.errorMessage = nil
        guard let name = profile.name, let write = model.use(profile) else { return }
        Task {
            guard let response = await write.value else { return }
            let resolved = response.active ?? name
            guard model.activeName == resolved else { return }
            onSave(DefaultProfileSelection(name: resolved,
                                           displayName: model.profiles.first { $0.name == resolved }?.displayName ?? profile.displayName,
                                           defaultModel: response.defaultModel))
            if openBotChat {
                guard resolved == name,
                      let tip = response.profiles?.first(where: { $0.name == name })?.canonicalSession?.tipSessionId,
                      let url = TalariaDeepLink.sessionURL(sessionID: tip, publisherID: server.absoluteString) else {
                    model.errorMessage = String(localized: "Bot Chat is no longer available for this profile.")
                    return
                }
                openURL(url)
            }
        }
    }
}
