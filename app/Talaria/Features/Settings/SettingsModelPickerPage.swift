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
    let dismissesOnSelection: Bool
    let onSelectOption: ((ModelCatalogOption) async -> Bool)?
    let recentModelKeys: [ModelFavoriteKey]
    let onSaveCustomOption: ((String, String?) async -> Bool)?
    let requiresCustomProviderID: Bool
    @ViewBuilder var leadingSections: (_ select: @escaping (String, String?) async -> Void) -> Leading

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: SettingsModelPickerViewModel
    @State private var expansion = ComposerModelPickerSectionExpansionState()
    @AppStorage("settings.modelPicker.collapsedProviders") private var collapsedProviders = Data()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let onCatalog: (ModelsResponse) -> Void
    @State private var customModel = ""
    @State private var customProviderID: String
    @State private var isSavingCustom = false

    init(title: String, server: URL, liveModels: Bool = false,
         isSelected: @escaping (ModelCatalogOption) -> Bool, isSavingModel: @escaping (ModelCatalogOption) -> Bool,
         isSaving: Bool, saveError: String?, customHelp: String,
         onSelect: @escaping (String, String?) async -> Bool, onSaveCustom: @escaping (String) async -> Bool,
         onCatalog: @escaping (ModelsResponse) -> Void = { _ in },
         catalog: SettingsModelPickerViewModel? = nil, dismissesOnSelection: Bool = true,
         onSelectOption: ((ModelCatalogOption) async -> Bool)? = nil,
         recentModelKeys: [ModelFavoriteKey] = [],
         onSaveCustomOption: ((String, String?) async -> Bool)? = nil,
         customProviderID: String = "", requiresCustomProviderID: Bool = false,
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
        self.dismissesOnSelection = dismissesOnSelection
        self.onSelectOption = onSelectOption
        self.recentModelKeys = recentModelKeys
        self.onSaveCustomOption = onSaveCustomOption
        self.requiresCustomProviderID = requiresCustomProviderID
        _customProviderID = State(initialValue: customProviderID)
        _catalog = State(initialValue: catalog ?? SettingsModelPickerViewModel(client: APIClient(baseURL: server), favorites: .shared, live: liveModels))
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

            if !catalog.visibleFavoriteOptions.isEmpty {
                SettingsSection(title: String(localized: "Favorites")) {
                    ForEach(catalog.visibleFavoriteOptions) { model in modelRow(model, mixedProviders: true) }
                }
            }
            if catalog.searchText.isEmpty && catalog.providerID.isEmpty && !catalog.favoritesOnly {
                let recent = ModelRecentsStore.visibleRecentOptions(in: catalog.groups, recentKeys: recentModelKeys,
                    favoriteKeys: catalog.favoriteOptions.map(\.favoriteKey), includesMissingModels: false)
                if !recent.isEmpty {
                    SettingsSection(title: String(localized: "Recent")) {
                        ForEach(recent) { model in modelRow(model, mixedProviders: true) }
                    }
                }
            }
            modelListContent
            customSection
        }
        .background(Color(.systemBackground))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: [catalog.searchText, catalog.providerID, String(catalog.favoritesOnly), String(catalog.showHidden)]) { await load() }
        .refreshesLive(showsStatus: !catalog.groups.isEmpty) { await load() }
        .onAppear {
            let saved = (try? JSONDecoder().decode(Set<String>.self, from: collapsedProviders)) ?? []
            expansion = ComposerModelPickerSectionExpansionState(collapsedGroupIDs: saved)
            expansion.updateSearchText(disclosureQuery)
            if customProviderID.isEmpty { customProviderID = catalog.response?.activeProvider ?? "" }
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
                        ForEach(group.models) { model in modelRow(model, mixedProviders: false) }
                    }
                } header: {
                    SidebarSectionHeader(title: group.name, providerID: group.providerID, toggle: {
                        withAnimation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion)) {
                            expansion.setExpanded(!expanded, groupID: group.id)
                        }
                        if let saved = try? JSONEncoder().encode(expansion.collapsedGroupIDs) { collapsedProviders = saved }
                    }) {
                        if let count = group.modelCount { Text(count.formatted()).foregroundStyle(.secondary) }
                        groupLimitBadge(group)
                        SidebarDisclosureChevron(isExpanded: expanded)
                    }
                    .accessibilityValue(Text([group.modelCount.map { String(localized: "Models") + ": " + $0.formatted() }, expanded ? String(localized: "Expanded") : String(localized: "Collapsed")].compactMap { $0 }.joined(separator: ", ")))
                }
            }
        }
    }

    private func modelRow(_ model: ModelCatalogOption, mixedProviders: Bool) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 0))
        return layout {
            Button {
                Task {
                    if let onSelectOption {
                        if await onSelectOption(model), dismissesOnSelection { dismiss() }
                    } else { await select(model.id, providerID: model.providerID) }
                }
            } label: {
                SettingsItemRow(title: model.displayName,
                                subtitle: model.id != model.displayName ? model.id : nil,
                                detail: model.isHidden ? String(localized: "Hidden") : nil,
                                isSelected: isSelected(model), isLoading: isSavingModel(model)) {
                    if mixedProviders, let providerID = model.providerID {
                        ProviderIconView(providerID: providerID, label: providerID)
                    }
                } badges: {
                    if let resetsAt = model.limitResetsAt {
                        Text("Limited until \(modelLimitResetTime(resetsAt))").font(.caption).foregroundStyle(.orange)
                    }
                } accessory: {
                    if !isSelected(model) { Color.clear.frame(width: 12, height: 1).accessibilityHidden(true) }
                }
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(isSelected(model) ? .isSelected : [])
            .accessibilityIdentifier("settings-model-option-\(model.id)")
            .contextMenu { preferenceActions(model) }

            if model.preferencesEditable {
                HStack(spacing: 0) {
                    Button { Task { await catalog.toggleFavorite(model) } } label: {
                        Image(systemName: model.isFavorite ? "star.fill" : "star")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings-model-star-\(model.id)")
                    .accessibilityLabel(model.isFavorite ? String(localized: "Remove \(model.displayName) from favorites") : String(localized: "Add \(model.displayName) to favorites"))
                    Button { Task { await catalog.toggleHidden(model) } } label: {
                        Image(systemName: model.isHidden ? "eye" : "eye.slash")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings-model-visibility-\(model.id)")
                    .accessibilityLabel(model.isHidden ? String(localized: "Unhide Model") : String(localized: "Hide Model"))
                    .accessibilityValue(model.displayName)
                }
            }
        }
    }

    private var customSection: some View {
        SettingsSection(title: String(localized: "Custom"), help: customHelp) {
            SettingsTextFieldRow(title: String(localized: "Custom model ID"), text: $customModel,
                                 placeholder: String(localized: "Custom model ID"), autocapitalization: .never)
            if onSaveCustomOption != nil {
                SettingsPickerRow(title: String(localized: "Provider"), systemImage: "server.rack", selection: $customProviderID) {
                    Text("Server Default").tag("")
                    ForEach(catalog.providers) { provider in Text(provider.label).tag(provider.id) }
                }
            }
            ModelPickerButton(String(localized: "Save Custom Model"), isLoading: isSavingCustom) {
                Task {
                    isSavingCustom = true
                    let id = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
                    let saved = if let onSaveCustomOption {
                        await onSaveCustomOption(id, customProviderID.isEmpty ? nil : customProviderID)
                    } else { await onSaveCustom(id) }
                    isSavingCustom = false
                    if saved, dismissesOnSelection { dismiss() }
                }
            }
            .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving
                      || requiresCustomProviderID && customProviderID.isEmpty)
        }
    }

    @ViewBuilder
    private func groupLimitBadge(_ group: ModelCatalogGroup) -> some View {
        if let label = group.availability?.displayLabel {
            Text(label).font(.caption).foregroundStyle(.secondary)
                .accessibilityHint(group.availability?.unavailableReason ?? "")
        } else if let resetsAt = group.accountLimitResetsAt {
            Text("Limited until \(modelLimitResetTime(resetsAt))").font(.caption).foregroundStyle(.red)
        } else if group.quotaLevel == .critical {
            Text("Quota nearly out").font(.caption).foregroundStyle(.red)
        } else if group.quotaLevel == .warning {
            Text("Low quota").font(.caption).foregroundStyle(.orange)
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
        if await onSelect(model, providerID), dismissesOnSelection { dismiss() }
    }
}

/// A rate-limit reset in the viewer's zone, including its weekday when it is not today.
private func modelLimitResetTime(_ date: Date) -> String {
    Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
}
