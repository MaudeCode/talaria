import SwiftUI
import TalariaKit

struct DefaultModelPickerView: View {
    let server: URL
    let currentDefaultModel: String?
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var isLoading = false
    @State private var groups: [ModelCatalogGroup] = []
    @State private var defaultModel: String?
    @State private var activeProvider: String?
    @State private var customModel = ""
    @State private var selectedModel: String?
    @State private var selectedProvider: String?
    @State private var searchText = ""
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var isSavingCustom = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    SettingsPickerSearchField(
                        text: $searchText,
                        prompt: "Search models",
                        clearLabel: "Clear model search"
                    )

                    if let saveError {
                        Text(saveError)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    SettingsPickerCard(title: String(localized: "Custom")) {
                        TextField("Custom model ID", text: $customModel)
                            .font(.subheadline)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                        Text("Type a model ID exactly as the server expects it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        ModelPickerButton(
                            String(localized: "Save Custom Model"),
                            isLoading: isSavingCustom
                        ) {
                            Task { await save(customModel, isCustom: true) }
                        }
                        .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                    }

                    modelListContent
                }
                .padding()
            }
            .navigationTitle("Default Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .task {
                await loadModels()
            }
        }
        .adaptiveFormPresentation()
    }

    @ViewBuilder
    private var modelListContent: some View {
        if isLoading && groups.isEmpty {
            SettingsPickerCard(title: String(localized: "Models")) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading models...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let errorMessage, groups.isEmpty {
            SettingsPickerCard(title: String(localized: "Models")) {
                Label("Could Not Load Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))

                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if filteredGroups.isEmpty {
            SettingsPickerCard(title: String(localized: "Models")) {
                Label("No Matching Models", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))

                Text("Try a different model name or ID.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            ForEach(filteredGroups) { group in
                SettingsPickerCard(title: group.name) {
                    VStack(spacing: 0) {
                        ForEach(Array(group.models.enumerated()), id: \.element.id) { index, model in
                            modelRow(model)

                            if index < group.models.count - 1 {
                                Divider()
                            }
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
            Task { await save(model.id, providerID: model.providerID) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.displayName)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)

                    if !model.id.isEmpty && model.id != model.displayName {
                        Text(model.id)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    }
                }

                Spacer(minLength: 12)

                if isSavingRow(model) {
                    ProgressView()
                } else if isCurrentDefault(model) {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 9)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSaving)
        .accessibilityLabel(modelAccessibilityLabel(for: model))
        .accessibilityValue(isCurrentDefault(model) ? "Selected" : "")
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

    /// Whether this row is the current default.
    ///
    /// Compared through `matchesSelection`, which normalizes the `@provider:`
    /// prefix the server adds to models outside the active provider. A raw `==`
    /// left the checkmark off every row whose saved spelling differed from the
    /// catalog's current one, so the picker could not answer "which one am I on"
    /// at all.
    ///
    /// The in-flight branch matches against the provider captured at tap time,
    /// so only the tapped row announces "Selected". The stored default is
    /// matched against the provider its own spelling names — an embedded
    /// `@provider:` prefix stays authoritative — falling back to
    /// `activeProvider` for a bare id, which belongs to whichever provider is
    /// active. Without that fallback, Core's catalog dedup can prefix the
    /// active provider's own rows while an inactive provider keeps the bare
    /// spelling, and the wrong row ticks.
    private func isCurrentDefault(_ model: ModelCatalogOption) -> Bool {
        DefaultModelPickerSelection.isChecked(
            model,
            selectedModel: selectedModel,
            selectedProvider: selectedProvider,
            defaultModel: defaultModel,
            activeProvider: activeProvider
        )
    }

    private func modelAccessibilityLabel(for model: ModelCatalogOption) -> String {
        guard !model.id.isEmpty, model.id != model.displayName else {
            return model.displayName
        }

        return "\(model.displayName), \(model.id)"
    }

    private func loadModels() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response = try await APIClient(baseURL: server).models()
            defaultModel = response.defaultModel ?? currentDefaultModel
            groups = response.catalogGroups
            activeProvider = response.activeProvider
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false

        await overlayLiveModels()
    }

    /// Overlays the active provider's live (uncached) list onto the cached
    /// catalog so newly available models appear. Failures are silent by
    /// design — the cached list stays as-is (issue #236).
    private func overlayLiveModels() async {
        guard let live = try? await APIClient(baseURL: server).modelsLive() else { return }
        groups = groups.mergingLiveModels(from: live)
    }

    private func save(_ model: String, providerID: String? = nil, isCustom: Bool = false) async {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isSaving = true
        isSavingCustom = isCustom
        saveError = nil
        selectedModel = trimmed
        selectedProvider = providerID

        do {
            let response = try await APIClient(baseURL: server).saveDefaultModel(model: trimmed, provider: providerID)
            if response.ok == true {
                onSave(trimmed)
                dismiss()
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

        isSaving = false
        isSavingCustom = false
    }

}
