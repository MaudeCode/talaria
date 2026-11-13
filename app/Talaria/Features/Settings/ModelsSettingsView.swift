import SwiftUI
import TalariaKit

struct ModelsSettingsView: View {
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    let server: URL
    @State private var model: ModelsSettingsViewModel

    init(server: URL) {
        self.server = server
        _model = State(initialValue: ModelsSettingsViewModel(client: APIClient(baseURL: server)))
    }

    var body: some View {
        SettingsCategoryPage(category: .models) {
            ServerSettingsSections(page: .limits)
            SettingsSection(title: String(localized: "Models")) {
                NavigationLink {
                    DefaultModelPicker(
                        server: server, currentDefaultModel: model.defaultModel,
                        onSave: { value in Task { await model.defaultModelChanged(value) } }
                    )
                } label: {
                    SettingsAccessoryRow(
                        title: SettingsIndex.modelsDefaultModel.title,
                        value: defaultModelLabel,
                        systemImage: "cpu"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the default model picker.")

                if model.showsReasoningEffort {
                    SettingsPickerRow(
                        title: SettingsIndex.modelsDefaultReasoning.title, systemImage: "brain",
                        selection: Binding(get: { model.reasoningEffort }, set: { model.setReasoningEffort($0) }),
                        accessibilityIdentifier: "settings-models-default-reasoning"
                    ) {
                        Text("Provider Default").tag("")
                        ForEach(model.supportedEfforts, id: \.self) { effort in
                            Text(ReasoningEffortOption.title(for: effort)).tag(effort)
                        }
                    }
                }

                if model.showsThinkingToggle {
                    SettingsToggleRow(
                        title: SettingsIndex.modelsShowThinking.title, systemImage: "text.bubble",
                        isOn: Binding(get: { model.showThinking }, set: { model.setShowThinking($0) }),
                        accessibilityIdentifier: "settings-models-show-thinking"
                    )
                }

                if let entry = scrollAnchor?.entry,
                   (entry == .modelsDefaultReasoning && !model.showsReasoningEffort)
                    || (entry == .modelsShowThinking && !model.showsThinkingToggle) {
                    SettingsInfoRow(title: entry.title, value: String(localized: "Not Available on This Server"))
                }

                NavigationLink {
                    AuxiliaryModelsSettingsView(server: server)
                } label: {
                    SettingsAccessoryRow(
                        title: SettingsIndex.modelsAuxiliaryModels.title,
                        systemImage: "square.stack.3d.up"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the models used for side tasks such as session titles.")
            }
            if let error = model.errorMessage { SettingsFootnote(error) }
        }
        .task { await model.load() }
        .refreshesLive(showsStatus: false) { await model.load() }
    }

    private var defaultModelLabel: String {
        if model.isLoading, model.defaultModel == nil { return String(localized: "Loading") }
        guard let defaultModel = model.defaultModel, !defaultModel.isEmpty else { return String(localized: "Not set") }
        return defaultModel
    }
}

/// The default picker's existing catalog and save state feeds the shared Settings page.
struct DefaultModelPicker: View {
    let server: URL
    let currentDefaultModel: String?
    let onSave: (String) -> Void

    @State private var defaultModel: String?
    @State private var defaultOptionID: String?
    @State private var selectedModel: String?
    @State private var selectedProvider: String?
    @State private var isSaving = false
    @State private var saveError: String?

    var body: some View {
        SettingsModelPickerPage(
            title: String(localized: "Default Model"), server: server, liveModels: true,
            isSelected: isCurrentDefault, isSavingModel: isSavingRow,
            isSaving: isSaving, saveError: saveError,
            customHelp: String(localized: "Type a model ID exactly as the server expects it."),
            onSelect: { await save($0, providerID: $1) },
            onSaveCustom: { await save($0) },
            onCatalog: { response in
                defaultModel = response.defaultModel ?? currentDefaultModel
                defaultOptionID = response.defaultOptionID
            }
        ) { _ in }
    }

    /// Whether this row shows the spinner for an in-flight save.
    ///
    /// Both the id and the provider recorded at tap time must agree: after
    /// the live overlay replaces the active provider's prefixed cached row
    /// with a bare id, two providers can offer the same spelling, and ticking
    /// by id alone would spin both rows.
    private func isSavingRow(_ model: ModelCatalogOption) -> Bool {
        isSaving && selectedModel == model.id && model.providerID == selectedProvider
    }

    /// Whether this row is the current default: the entry the server says
    /// the stored default selects, or, while a save is in flight, the tapped row.
    private func isCurrentDefault(_ model: ModelCatalogOption) -> Bool {
        DefaultModelPickerSelection.isChecked(
            model,
            selectedModel: selectedModel,
            selectedProvider: selectedProvider,
            defaultOptionID: defaultOptionID,
            defaultModel: defaultModel
        )
    }

    private func save(_ model: String, providerID: String? = nil) async -> Bool {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        isSaving = true
        defer { isSaving = false }
        saveError = nil
        selectedModel = trimmed
        selectedProvider = providerID

        do {
            let response = try await APIClient(baseURL: server).saveDefaultModel(model: trimmed, provider: providerID)
            if response.ok == true {
                onSave(trimmed)
                return true
            } else {
                saveError = String(localized: "The server did not confirm the change.")
                selectedModel = nil
                selectedProvider = nil
            }
        } catch {
            saveError = error.localizedDescription
            selectedModel = nil
            selectedProvider = nil
        }

        return false
    }
}
