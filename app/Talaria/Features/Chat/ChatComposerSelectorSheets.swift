import SwiftUI
import TalariaKit

/// The shared Settings picker in an interaction sheet; Settings keeps its pushed presentation.
struct ComposerModelPickerSheet: View {
    let client: APIClient
    var catalog: SettingsModelPickerViewModel? = nil
    let selectedModelID: String?
    let selectedModelProviderID: String?
    let selectedModelOptionID: String?
    var recentModelKeys: [ModelFavoriteKey] = []
    let onSelect: (ModelCatalogOption) -> Void
    var keepsSelectionOpen = false
    var requiresCustomProviderID = true
    var onClear: (() -> Void)? = nil
    var showsReasoningControl = false
    var selectedReasoningEffort: String? = nil
    var supportedReasoningEfforts: [String]? = nil
    var isEffortDisabled = false
    var isSelectionDisabled = false
    var errorMessage: String? = nil
    var onSelectReasoningEffort: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SettingsModelPickerPage(
                title: String(localized: "Choose Model"), server: client.baseURL, liveModels: true,
                isSelected: { $0.isSelected(optionID: selectedModelOptionID, modelID: selectedModelID, providerID: selectedModelProviderID) },
                isSavingModel: { _ in false }, isSaving: isSelectionDisabled, saveError: errorMessage,
                customHelp: String(localized: "Type a model ID exactly as the server expects it."),
                onSelect: { model, provider in select(ModelCatalogOption(id: model, displayName: model, providerID: provider)) },
                onSaveCustom: { _ in false },
                catalog: catalog ?? SettingsModelPickerViewModel(client: client, favorites: .shared, live: true), dismissesOnSelection: !keepsSelectionOpen,
                onSelectOption: { select($0) }, recentModelKeys: recentModelKeys,
                onSaveCustomOption: { model, provider in
                    guard let option = ComposerCustomModelOption.customOption(modelID: model, providerID: provider ?? "", requiresProviderID: requiresCustomProviderID) else { return false }
                    return select(option)
                }, customProviderID: selectedModelProviderID ?? "", requiresCustomProviderID: requiresCustomProviderID
            ) { _ in
                if showsReasoningControl {
                    SettingsSection(title: String(localized: "Options")) { effortRow }
                }
                if let onClear {
                    SettingsSection(title: String(localized: "Model")) {
                        Button {
                            onClear()
                            dismiss()
                        } label: {
                            SettingsItemRow(title: String(localized: "Server Default"), isSelected: selectedModelID == nil)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func select(_ option: ModelCatalogOption) -> Bool {
        onSelect(option)
        return true
    }

    private var effortTitle: String {
        ReasoningEffortOption.summary(selectedEffort: selectedReasoningEffort, supportedEfforts: supportedReasoningEfforts, showsEffort: true)
            ?? String(localized: "Reasoning")
    }

    @ViewBuilder
    private var effortRow: some View {
        let options = ReasoningEffortOption.options(forSupportedEfforts: supportedReasoningEfforts)
        if options.count == 1 {
            SettingsValueRow(title: String(localized: "Effort"), systemImage: "brain") { Text(effortTitle).foregroundStyle(.secondary) }
                .accessibilityIdentifier("composer-model-effort")
        } else {
            NavigationLink {
                SettingsPage(title: String(localized: "Effort")) {
                    if let errorMessage { SettingsErrorFootnote(SettingsErrorText(errorMessage)) }
                    SettingsSection(title: String(localized: "Effort")) {
                        ForEach(options) { option in
                            Button { onSelectReasoningEffort(option.id) } label: {
                                SettingsItemRow(title: option.title, isSelected: option.id == selectedReasoningEffort)
                            }
                            .buttonStyle(.plain)
                            .disabled(isEffortDisabled)
                            .accessibilityIdentifier("composer-effort-\(option.id)")
                            .accessibilityAddTraits(option.id == selectedReasoningEffort ? .isSelected : [])
                        }
                    }
                }
            } label: {
                SettingsAccessoryRow(title: String(localized: "Effort"), value: effortTitle, systemImage: "brain")
            }
            .disabled(isEffortDisabled)
            .accessibilityIdentifier("composer-model-effort")
        }
    }
}

struct WorkspacePickerRow: Identifiable, Hashable {
    var id: String { path }
    let path: String
    let name: String?
}

extension Array where Element == WorkspacePickerRow {
    func deduplicated() -> [WorkspacePickerRow] {
        var seen = Set<String>()
        return filter { seen.insert($0.path).inserted }
    }
}
