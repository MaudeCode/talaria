import SwiftUI
import TalariaKit

/// The shared Settings picker layout; callers own loading, selection and persistence.
struct SettingsModelPickerPage<Leading: View>: View {
    let title: String
    let groups: [ModelCatalogGroup]
    let isLoading: Bool
    let loadError: String?
    let isSelected: (ModelCatalogOption) -> Bool
    let isSavingModel: (ModelCatalogOption) -> Bool
    let isSaving: Bool
    let saveError: String?
    let customHelp: String
    let onSelect: (String, String?) async -> Bool
    let onSaveCustom: (String) async -> Bool
    @ViewBuilder var leadingSections: (_ select: @escaping (String, String?) async -> Void) -> Leading

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var customModel = ""
    @State private var isSavingCustom = false

    var body: some View {
        SettingsPage(title: title) {
            SettingsPickerSearchField(text: $searchText, prompt: "Search models", clearLabel: "Clear model search")

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
    }

    @ViewBuilder
    private var modelListContent: some View {
        if isLoading && groups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading models...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let loadError, groups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                Label("Could Not Load Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))

                Text(loadError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if filteredGroups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                Label("No Matching Models", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))

                Text("Try a different model name or ID.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            ForEach(filteredGroups) { group in
                SettingsSection(title: group.name) {
                    Group {
                        ForEach(group.models) { model in
                            modelRow(model)
                        }
                    }
                }
            }
        }
    }

    private var filteredGroups: [ModelCatalogGroup] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return groups }

        return groups.compactMap { group in
            let matchingModels = group.models.filter { model in
                model.displayName.lowercased().contains(query)
                    || model.id.lowercased().contains(query)
                    || group.name.lowercased().contains(query)
            }

            guard !matchingModels.isEmpty else { return nil }
            return ModelCatalogGroup(
                id: group.id,
                name: group.name,
                providerID: group.providerID,
                models: matchingModels
            )
        }
    }

    private func modelRow(_ model: ModelCatalogOption) -> some View {
        Button {
            Task { await select(model.id, providerID: model.providerID) }
        } label: {
            SettingsItemRow(title: model.displayName,
                            subtitle: !model.id.isEmpty && model.id != model.displayName ? model.id : nil,
                            isSelected: isSelected(model), isLoading: isSavingModel(model)) {
                Image(systemName: "cpu").accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .disabled(isSaving)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected(model) ? .isSelected : [])
    }

    private func select(_ model: String, providerID: String?) async {
        if await onSelect(model, providerID) { dismiss() }
    }
}
