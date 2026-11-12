import SwiftUI
import TalariaKit

struct ModelsSettingsView: View {
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    let server: URL
    @State private var model: ModelsSettingsViewModel
    @State private var showDefaultModelPicker = false

    init(server: URL) {
        self.server = server
        _model = State(initialValue: ModelsSettingsViewModel(client: APIClient(baseURL: server)))
    }

    var body: some View {
        SettingsCategoryPage(category: .models) {
            ServerSettingsSections(page: .limits)
            SettingsSection(title: String(localized: "Models")) {
                HapticButton {
                    showDefaultModelPicker = true
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
        .sheet(isPresented: $showDefaultModelPicker) {
            DefaultModelPickerView(
                server: server,
                currentDefaultModel: model.defaultModel,
                onSave: { value in Task { await model.defaultModelChanged(value) } }
            )
        }
    }

    private var defaultModelLabel: String {
        if model.isLoading, model.defaultModel == nil { return String(localized: "Loading") }
        guard let defaultModel = model.defaultModel, !defaultModel.isEmpty else { return String(localized: "Not set") }
        return defaultModel
    }
}
