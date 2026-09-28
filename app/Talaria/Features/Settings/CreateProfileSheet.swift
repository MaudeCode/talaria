import SwiftUI
import TalariaKit

struct CreateProfileSheet: View {
    let server: URL
    /// Called with the server-reported profile on success (nil if the response
    /// omitted it); the picker reconciles with a fresh `/api/profiles` fetch.
    let onCreated: (ProfileSummary?) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var cloneConfig = false
    @State private var modelGroups: [ModelCatalogGroup] = []
    /// nil = "Use active profile default" (the webui form's empty option).
    @State private var selectedModel: ModelCatalogOption?
    @State private var baseURL = ""
    @State private var apiKey = ""
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Profile name", text: $name)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } footer: {
                    Text("Lowercase letters, numbers, hyphens, and underscores; must start with a letter or number.")
                }

                Section {
                    Toggle("Clone config from active profile", isOn: $cloneConfig)
                }

                Section {
                    modelPicker
                } footer: {
                    Text("Choose from configured providers and models for this new profile.")
                }

                Section {
                    TextField("Base URL", text: $baseURL)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    SecureField("API key", text: $apiKey)
                } footer: {
                    if hasInvalidBaseURL {
                        Text("Base URL must start with http:// or https://.")
                            .foregroundStyle(.red)
                    } else {
                        Text("Optional. Base URL example: http://localhost:11434")
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .disabled(isCreating)
            .navigationTitle("New Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .disabled(isCreating)
                }

                ToolbarItem(placement: .confirmationAction) {
                    if isCreating {
                        ProgressView()
                    } else {
                        Button("Create") {
                            Task { await create() }
                        }
                        .disabled(!ProfileNameRules.isValid(trimmedName) || hasInvalidBaseURL)
                    }
                }
            }
            .interactiveDismissDisabled(isCreating)
            .task {
                await loadModels()
            }
        }
        .adaptiveFormPresentation()
    }

    private var modelPicker: some View {
        Picker("Model", selection: $selectedModel) {
            Text("Use active profile default")
                .tag(ModelCatalogOption?.none)

            ForEach(modelGroups) { group in
                Section(group.name) {
                    ForEach(pickerOptions(for: group)) { option in
                        Text(option.displayName)
                            .tag(Optional(option))
                    }
                }
            }
        }
        .pickerStyle(.menu)
    }

    /// The webui form lists `models` + `extra_models`; the parser doesn't
    /// dedupe across the two, so drop repeats to keep ForEach identity unique.
    private func pickerOptions(for group: ModelCatalogGroup) -> [ModelCatalogOption] {
        var seen = Set<ModelCatalogOption>()
        return (group.models + group.extraModels).filter { seen.insert($0).inserted }
    }

    // The webui lowercases the typed name before validating/submitting —
    // mirror that so "Work" creates "work" instead of dead-ending validation.
    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var trimmedBaseURL: String {
        baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasInvalidBaseURL: Bool {
        !trimmedBaseURL.isEmpty && !ProfileNameRules.isValidBaseURL(trimmedBaseURL)
    }

    private func loadModels() async {
        // Best-effort, like the webui form: on failure the picker simply keeps
        // only the "Use active profile default" option.
        guard let response = try? await APIClient(baseURL: server).models() else { return }
        modelGroups = response.catalogGroups
    }

    private func create() async {
        let profileName = trimmedName
        guard ProfileNameRules.isValid(profileName), !hasInvalidBaseURL else { return }

        isCreating = true
        errorMessage = nil
        defer { isCreating = false }

        // Mirror the webui payload: a "default" provider id is not a real
        // provider selection and is dropped.
        let provider = selectedModel?.providerID
        let trimmedAPIKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let response = try await APIClient(baseURL: server).createProfile(
                name: profileName,
                cloneConfig: cloneConfig,
                defaultModel: selectedModel?.id,
                modelProvider: provider == "default" ? nil : provider,
                baseUrl: trimmedBaseURL.isEmpty ? nil : trimmedBaseURL,
                apiKey: trimmedAPIKey.isEmpty ? nil : trimmedAPIKey
            )
            if let error = response.error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
                errorMessage = error
                return
            }

            onCreated(response.profile)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
