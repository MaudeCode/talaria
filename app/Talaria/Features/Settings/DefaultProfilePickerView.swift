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
    @State private var isLoading = false
    @State private var profiles: [ProfileSummary] = []
    @State private var activeProfileName: String?
    @State private var selectedProfileName: String?
    @State private var searchText = ""
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var isSingleProfileMode = false
    @State private var showsCreateProfile = false

    var body: some View {
        SettingsPage(title: String(localized: "Profiles")) {
            SettingsPickerSearchField(
                text: $searchText,
                prompt: "Search profiles",
                clearLabel: "Clear profile search"
            )

            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            profileListContent

            // The server 403s profile creation in single-profile mode,
            // so the affordance is hidden there (#24).
            if !isSingleProfileMode {
                newProfileButton
            }
        }
        .background(Color(.systemBackground))
        .navigationTitle("Profiles")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadProfiles()
        }
        .refreshesLive(showsStatus: !profiles.isEmpty) {
            await loadProfiles()
        }
        .sheet(isPresented: $showsCreateProfile) {
            CreateProfileSheet(server: server) { createdProfile in
                // Optimistic append so the new profile is visible immediately,
                // then a fresh fetch reconciles paths/flags from the server.
                if let createdProfile, !profiles.contains(createdProfile) {
                    profiles.append(createdProfile)
                }
                Task { await loadProfiles() }
            }
        }
    }

    private var newProfileButton: some View {
        Button {
            showsCreateProfile = true
        } label: {
            SettingsItemRow(title: String(localized: "New Profile")) {
                Image(systemName: "plus.circle").accessibilityHidden(true)
            }
            .sidebarRowPadding()
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
        .sidebarRow(isSelected: false)
        .disabled(isLoading)
        .accessibilityHint("Opens the new profile form.")
    }

    @ViewBuilder
    private var profileListContent: some View {
        if isLoading && profiles.isEmpty {
            SettingsSection(title: String(localized: "Profiles")) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading profiles...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let errorMessage, profiles.isEmpty {
            SettingsSection(title: String(localized: "Profiles")) {
                Label("Could Not Load Profiles", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))

                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if filteredProfiles.isEmpty {
            SettingsSection(title: String(localized: "Profiles")) {
                Label("No Matching Profiles", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))

                Text("Try a different profile name.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            SettingsSection(title: String(localized: "Profiles")) {
                ForEach(filteredProfiles, id: \.self) { profile in
                    profileRow(profile)
                }
            }
        }
    }

    private var filteredProfiles: [ProfileSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return profiles }

        return profiles.filter { profile in
            profile.displayName.lowercased().contains(query)
                || (profile.normalizedName?.lowercased().contains(query) ?? false)
                || (profile.model?.lowercased().contains(query) ?? false)
                || (profile.provider?.lowercased().contains(query) ?? false)
        }
    }

    private func profileRow(_ profile: ProfileSummary) -> some View {
        HStack(spacing: 0) {
            Button {
                Task { await save(profile) }
            } label: {
                SettingsItemRow(title: profile.displayName, subtitle: profileDetails(profile), detail: profile.description,
                                isSelected: isSelected(profile), isLoading: isSaving && selectedProfileName == profile.normalizedName) {
                    Image(systemName: "person.crop.circle").accessibilityHidden(true)
                } badges: {
                    if isSelected(profile) { ProfileStatusBadge(title: String(localized: "Selected")) }
                    else if profile.isDefault == true { ProfileStatusBadge(title: String(localized: "Server Default")) }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(profileAccessibilityLabel(for: profile))
            .accessibilityValue(profileAccessibilityValue(for: profile))

            if profile.canonicalSession != nil {
                botChatButton(profile)
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
        }
        .disabled(isSaving || profile.normalizedName == nil)
        .contextMenu {
            if profile.canonicalSession != nil { botChatButton(profile) }
        }
    }

    private func botChatButton(_ profile: ProfileSummary) -> some View {
        Button {
            Task { await save(profile, openBotChat: true) }
        } label: {
            Label("Open Bot Chat", systemImage: "arrow.up.right")
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("profile-open-bot-chat-\(profile.name ?? "")")
    }

    private func profileAccessibilityLabel(for profile: ProfileSummary) -> String {
        [profile.displayName, profileDetails(profile), profile.description]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }

    private func profileAccessibilityValue(for profile: ProfileSummary) -> String {
        if isSelected(profile) {
            return "Selected"
        }

        return profile.isDefault == true ? "Server Default" : ""
    }

    private func isSelected(_ profile: ProfileSummary) -> Bool {
        guard let name = profile.normalizedName else { return false }
        return (selectedProfileName ?? activeProfileName) == name
    }

    private func profileDetails(_ profile: ProfileSummary) -> String? {
        var details: [String] = []

        if let botDisplayName = profile.botDisplayName, !botDisplayName.isEmpty, let name = profile.name {
            details.append(name)
        }

        if let model = profile.model?.trimmingCharacters(in: .whitespacesAndNewlines), !model.isEmpty {
            details.append(model)
        }

        if let provider = profile.provider?.trimmingCharacters(in: .whitespacesAndNewlines), !provider.isEmpty {
            details.append(provider)
        }

        if let skillCount = profile.skillCount {
            details.append(String(localized: "\(skillCount) skills"))
        }

        guard !details.isEmpty else { return nil }
        return details.joined(separator: " - ")
    }

    private func loadProfiles() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response = try await APIClient(baseURL: server).profiles()
            profiles = response.profiles ?? []
            activeProfileName = response.effectiveDefaultProfileName ?? currentDefaultProfileName
            isSingleProfileMode = response.singleProfileMode ?? false
        } catch {
            // A cancelled .task (view dismissed mid-load) must not surface a
            // "cancelled" error into state.
            if !APIError.isCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    private func save(_ profile: ProfileSummary, openBotChat: Bool = false) async {
        guard let name = profile.normalizedName else { return }

        isSaving = true
        saveError = nil
        selectedProfileName = name
        defer {
            isSaving = false
            selectedProfileName = nil
        }

        do {
            let response = try await APIClient(baseURL: server).switchProfile(name: name)
            if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
                saveError = error
                return
            }

            let returnedActiveName = response.active?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedName = returnedActiveName?.isEmpty == false ? returnedActiveName : name
            let updatedProfiles = response.profiles ?? profiles
            let selectionResponse = ProfilesResponse(profiles: updatedProfiles, active: resolvedName)
            profiles = updatedProfiles
            activeProfileName = selectionResponse.effectiveDefaultProfileName ?? name

            let selection = DefaultProfileSelection(
                name: activeProfileName ?? name,
                displayName: selectionResponse.displayName(for: activeProfileName) ?? profile.displayName,
                defaultModel: response.defaultModel
            )
            onSave(selection)

            if openBotChat {
                guard resolvedName == name,
                      let tip = response.profiles?.first(where: { $0.normalizedName == name })?.canonicalSession?.tipSessionId,
                      let url = TalariaDeepLink.sessionURL(sessionID: tip, publisherID: server.absoluteString) else {
                    saveError = String(localized: "Bot Chat is no longer available for this profile.")
                    return
                }
                openURL(url)
            }
        } catch {
            saveError = error.localizedDescription
        }
    }
}
