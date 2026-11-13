import SwiftUI
import TalariaKit

/// Shared Settings catalog controls; callers retain selected-model persistence.
struct SettingsModelPickerPage<Leading: View>: View {
    let title: String
    let isSelected: (ModelCatalogOption) -> Bool
    let isSavingModel: (ModelCatalogOption) -> Bool
    let isSaving: Bool
    let saveError: String?
    let customHelp: String
    let onSelect: (String, String?) async -> Bool
    let onSaveCustom: (String) async -> Bool
    @ViewBuilder var leadingSections: (_ select: @escaping (String, String?) async -> Void) -> Leading

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: SettingsModelPickerViewModel
    @State private var expansion = ComposerModelPickerSectionExpansionState(initiallyExpanded: true)
    @AppStorage("settings.modelPicker.collapsedProviders") private var collapsedProviders = Data()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let onCatalog: (ModelsResponse) -> Void
    @State private var customModel = ""
    @State private var isSavingCustom = false

    init(title: String, server: URL, liveModels: Bool = false,
         isSelected: @escaping (ModelCatalogOption) -> Bool, isSavingModel: @escaping (ModelCatalogOption) -> Bool,
         isSaving: Bool, saveError: String?, customHelp: String,
         onSelect: @escaping (String, String?) async -> Bool, onSaveCustom: @escaping (String) async -> Bool,
         onCatalog: @escaping (ModelsResponse) -> Void = { _ in },
         @ViewBuilder leadingSections: @escaping (@escaping (String, String?) async -> Void) -> Leading) {
        self.title = title
        self.isSelected = isSelected
        self.isSavingModel = isSavingModel
        self.isSaving = isSaving
        self.saveError = saveError
        self.customHelp = customHelp
        self.onSelect = onSelect
        self.onSaveCustom = onSaveCustom
        self.onCatalog = onCatalog
        self.leadingSections = leadingSections
        _catalog = State(initialValue: SettingsModelPickerViewModel(client: APIClient(baseURL: server), favorites: .shared, live: liveModels))
    }

    var body: some View {
        @Bindable var catalog = catalog
        SettingsPage(title: title) {
            SettingsPickerSearchField(text: $catalog.searchText, prompt: "Search models", clearLabel: "Clear model search", trailing: {
                Menu {
                    SettingsPickerRow(title: String(localized: "Provider"), systemImage: "server.rack", selection: $catalog.providerID, isMenuItem: true) {
                        Text("All Providers").tag("")
                        ForEach(catalog.providers) { provider in Text(provider.label).tag(provider.id) }
                    }
                    SettingsToggleRow(title: String(localized: "Favorites Only"), systemImage: "star", isOn: $catalog.favoritesOnly, isMenuItem: true)
                    SettingsToggleRow(title: String(localized: "Show Hidden"), systemImage: "eye", isOn: $catalog.showHidden, isMenuItem: true)
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Filter Models")
            })
            if let error = catalog.preferenceError { SettingsErrorFootnote(SettingsErrorText(error)) }
            if let error = catalog.errorMessage, !catalog.groups.isEmpty { SettingsErrorFootnote(SettingsErrorText(error)) }

            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            leadingSections { model, providerID in
                await select(model, providerID: providerID)
            }

            SettingsSection(title: String(localized: "Custom"), help: customHelp) {
                SettingsTextFieldRow(title: String(localized: "Custom model ID"), text: $customModel,
                                     placeholder: String(localized: "Custom model ID"), autocapitalization: .never)
                ModelPickerButton(String(localized: "Save Custom Model"), isLoading: isSavingCustom) {
                    Task {
                        isSavingCustom = true
                        let saved = await onSaveCustom(customModel.trimmingCharacters(in: .whitespacesAndNewlines))
                        isSavingCustom = false
                        if saved { dismiss() }
                    }
                }
                .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }

            modelListContent
        }
        .background(Color(.systemBackground))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: [catalog.searchText, catalog.providerID, String(catalog.favoritesOnly), String(catalog.showHidden)]) { await load() }
        .refreshesLive(showsStatus: !catalog.groups.isEmpty) { await load() }
        .onAppear {
            let saved = (try? JSONDecoder().decode(Set<String>.self, from: collapsedProviders)) ?? []
            expansion = ComposerModelPickerSectionExpansionState(initiallyExpanded: true, collapsedGroupIDs: saved)
            expansion.updateSearchText(disclosureQuery)
        }
        .onReceive(NotificationCenter.default.publisher(for: SettingsModelPickerViewModel.preferencesDidChange)) { change in
            Task { await catalog.refreshPreferences(after: change) }
        }
        .onChange(of: disclosureQuery) { _, value in expansion.updateSearchText(value) }
        .onChange(of: catalog.response, initial: true) { _, response in
            if let response { onCatalog(response) }
        }
    }

    private var disclosureQuery: String {
        if catalog.searchText.isEmpty && catalog.providerID.isEmpty { return "" }
        return catalog.searchText + "\0" + catalog.providerID
    }

    private func load() async {
        await catalog.load()
    }

    @ViewBuilder
    private var modelListContent: some View {
        if catalog.isLoading && catalog.groups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading models...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let loadError = catalog.errorMessage, catalog.groups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                Label("Could Not Load Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))

                Text(loadError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if catalog.groups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                Label("No Matching Models", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))

                Text("Try a different model name or ID.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            ForEach(catalog.groups) { group in
                let expanded = expansion.isExpanded(groupID: group.id)
                SettingsSection {
                    if expanded {
                        ForEach(group.models) { model in modelRow(model, providerLabel: group.name) }
                    }
                } header: {
                    SidebarSectionHeader(title: group.name, toggle: {
                        withAnimation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion)) {
                            expansion.setExpanded(!expanded, groupID: group.id)
                        }
                        if let saved = try? JSONEncoder().encode(expansion.collapsedGroupIDs) { collapsedProviders = saved }
                    }) {
                        if let count = group.modelCount { Text(count.formatted()).foregroundStyle(.secondary) }
                        SidebarDisclosureChevron(isExpanded: expanded)
                    }
                    .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
                }
            }
        }
    }

    private func modelRow(_ model: ModelCatalogOption, providerLabel: String) -> some View {
        HStack(spacing: 0) {
            Button {
                Task { await select(model.id, providerID: model.providerID) }
            } label: {
                SettingsItemRow(title: model.displayName,
                                subtitle: model.id != model.displayName ? model.id : nil,
                                detail: model.isHidden ? String(localized: "Hidden") : nil,
                                isSelected: isSelected(model), isLoading: isSavingModel(model)) {
                    Image(systemName: "cpu").accessibilityHidden(true)
                }
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(isSelected(model) ? .isSelected : [])
            .accessibilityIdentifier("settings-model-option-\(model.id)")
            .contextMenu { preferenceActions(model) }

            if model.preferencesEditable {
                Button { Task { await catalog.toggleFavorite(model) } } label: {
                    Image(systemName: model.isFavorite ? "star.fill" : "star")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-model-star-\(model.id)")
                .accessibilityLabel(model.isFavorite ? String(localized: "Remove \(model.displayName) from favorites") : String(localized: "Add \(model.displayName) to favorites"))
                Menu { preferenceActions(model) } label: {
                    Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel(String(localized: "Actions for \(model.displayName), \(providerLabel)"))
            }
        }
    }

    @ViewBuilder
    private func preferenceActions(_ model: ModelCatalogOption) -> some View {
        if model.preferencesEditable {
            Button(model.isFavorite ? String(localized: "Remove from Favorites") : String(localized: "Add to Favorites"), systemImage: model.isFavorite ? "star.slash" : "star") {
                Task { await catalog.toggleFavorite(model) }
            }
            Button(model.isHidden ? String(localized: "Unhide Model") : String(localized: "Hide Model"), systemImage: model.isHidden ? "eye" : "eye.slash") {
                Task { await catalog.toggleHidden(model) }
            }
        }
    }

    private func select(_ model: String, providerID: String?) async {
        if await onSelect(model, providerID) { dismiss() }
    }
}
