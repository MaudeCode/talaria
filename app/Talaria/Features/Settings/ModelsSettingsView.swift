import SwiftUI
import TalariaKit

struct ModelsSettingsView: View {
    let server: URL
    @State private var defaultModel: String?
    @State private var isLoadingDefaultModel = false
    @State private var showDefaultModelPicker = false

    var body: some View {
        SettingsCategoryPage(category: .models) {
            SettingsCard(title: String(localized: "Models")) {
                HapticButton {
                    showDefaultModelPicker = true
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Default Model"),
                        value: defaultModelLabel,
                        systemImage: "cpu"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the default model picker.")

                SettingsDivider()

                NavigationLink {
                    AuxiliaryModelsSettingsView(server: server)
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Auxiliary Models"),
                        systemImage: "square.stack.3d.up"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the models used for side tasks such as session titles.")
            }
        }
        .task { await loadDefaults() }
        .refreshesLive(showsStatus: false) { await loadDefaults() }
        .sheet(isPresented: $showDefaultModelPicker) {
            DefaultModelPickerView(
                server: server,
                currentDefaultModel: defaultModel,
                onSave: { defaultModel = $0 }
            )
        }
    }

    private var defaultModelLabel: String {
        if isLoadingDefaultModel { return String(localized: "Loading") }
        guard let defaultModel, !defaultModel.isEmpty else { return String(localized: "Not set") }
        return defaultModel
    }

    @MainActor
    private func loadDefaults() async {
        let client = APIClient(baseURL: server)
        isLoadingDefaultModel = true

        do {
            defaultModel = try await client.models().defaultModel
        } catch {
            defaultModel = nil
        }
        isLoadingDefaultModel = false
    }
}
