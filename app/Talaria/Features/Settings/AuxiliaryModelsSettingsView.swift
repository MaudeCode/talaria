import SwiftUI
import TalariaKit

/// Settings > Servers > Auxiliary Models (TAL-388): the server's side-task
/// slots in server order. Tapping a task opens a searchable model sheet.
struct AuxiliaryModelsSettingsView: View {
    let server: URL

    @State private var viewModel: AuxiliaryModelsViewModel
    @State private var editingTask: AuxiliaryModelTask?
    @State private var isConfirmingReset = false

    init(server: URL) {
        self.server = server
        _viewModel = State(initialValue: AuxiliaryModelsViewModel(server: server))
    }

    var body: some View {
        SettingsPage(title: String(localized: "Auxiliary Models")) {
            content
        }
        .background(Color(.systemBackground))
        .navigationTitle("Auxiliary Models")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.load() }
        .refreshesLive(showsStatus: !viewModel.tasks.isEmpty) { await viewModel.load() }
        .sheet(item: $editingTask) { task in
            AuxiliaryModelPickerSheet(viewModel: viewModel, taskID: task.task)
        }
        .alert("Reset auxiliary models?", isPresented: $isConfirmingReset) {
            Button("Cancel", role: .cancel) {}
            Button("Reset All", role: .destructive) {
                Task { await viewModel.resetAll() }
            }
        } message: {
            Text("Every task returns to Auto and uses the main model. The default model stays the same.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isUnavailable {
            SettingsSection(title: String(localized: "Auxiliary Models")) {
                Label("Not Available on This Server", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                SettingsFootnote(String(localized: "Update the Talaria Web server to choose models for side tasks."))
            }
        } else if viewModel.tasks.isEmpty, viewModel.isLoading || viewModel.errorMessage == nil {
            SettingsSection(title: String(localized: "Tasks")) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading auxiliary models...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if viewModel.tasks.isEmpty, let errorMessage = viewModel.errorMessage {
            SettingsSection(title: String(localized: "Tasks")) {
                Label("Could Not Load Auxiliary Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                SettingsFootnote(errorMessage)
                SettingsButton(String(localized: "Try Again")) {
                    Task { await viewModel.load() }
                }
            }
        } else {
            SettingsSection(title: String(localized: "Tasks")) {
                ForEach(viewModel.tasks) { task in
                    taskRow(task)
                }
                SettingsFootnote(String(localized: "Models for side tasks such as session titles, vision, and compression. Auto uses the main model."))

                if let saveError = viewModel.saveErrorMessage, editingTask == nil {
                    Text(saveError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                SettingsButton(
                    String(localized: "Reset All to Auto"),
                    role: .destructive,
                    isLoading: viewModel.savingTaskID == AuxiliaryModelsViewModel.resetTaskID
                ) {
                    isConfirmingReset = true
                }
                .disabled(viewModel.savingTaskID != nil)
            }
        }
    }

    private func taskRow(_ task: AuxiliaryModelTask) -> some View {
        Button {
            viewModel.clearSaveError()
            editingTask = task
        } label: {
            SettingsItemRow(title: task.label, subtitle: task.description, accessorySystemImage: "chevron.forward") {
                Image(systemName: "cpu").accessibilityHidden(true)
            } badges: {
                AuxiliaryModelValueText(task: task)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the model picker for this task.")
    }
}

/// "Auto · main model", or the pinned provider and model; flags a pinned model the catalog no longer lists.
private struct AuxiliaryModelValueText: View {
    let task: AuxiliaryModelTask

    var body: some View {
        let model = [task.providerLabel, task.valueLabel].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        HStack(spacing: 6) {
            if task.isAuto == true {
                Text(model.isEmpty ? String(localized: "Auto") : String(localized: "Auto · \(model)"))
                    .foregroundStyle(Color.accentColor)
            } else {
                Text(model)
                    .foregroundStyle(.primary)
            }
            if task.inCatalog == false {
                Text("Not in catalog")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .overlay(Capsule().stroke(Color.secondary.opacity(0.4)))
            }
        }
        .font(.caption)
    }
}

private struct AuxiliaryModelPickerSheet: View {
    let viewModel: AuxiliaryModelsViewModel
    let taskID: String

    @State private var searchText = ""
    @State private var customModel = ""
    @Environment(\.dismiss) private var dismiss

    private var task: AuxiliaryModelTask? { viewModel.task(id: taskID) }

    var body: some View {
        NavigationStack {
            SettingsPage(title: task?.label ?? String(localized: "Auxiliary Model")) {
                SettingsPickerSearchField(text: $searchText, prompt: "Search models", clearLabel: "Clear model search")

                if let saveError = viewModel.saveErrorMessage {
                    Text(saveError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let task {
                    SettingsSection(title: String(localized: "Current")) {
                        Group {
                            optionRow(title: String(localized: "Auto"), subtitle: String(localized: "Use the main model"), isSelected: task.isAuto == true) {
                                await save(model: "", provider: "auto")
                            }
                            if task.inCatalog == false {
                                SettingsDivider()
                                optionRow(title: task.valueLabel ?? task.model, subtitle: [task.providerLabel, String(localized: "Not in catalog")].compactMap { $0 }.joined(separator: " · "), isSelected: true) {
                                    await save(model: task.model, provider: task.provider)
                                }
                            }
                        }
                    }
                }

                SettingsSection(title: String(localized: "Custom")) {
                    SettingsTextFieldRow(title: String(localized: "Custom model ID"), text: $customModel,
                                         placeholder: String(localized: "Custom model ID"), autocapitalization: .never)
                    Text("Use @provider:model to pin a provider.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ModelPickerButton(String(localized: "Save Custom Model"), isLoading: viewModel.savingTaskID != nil && !customModel.isEmpty) {
                        Task { await save(model: customModel.trimmingCharacters(in: .whitespacesAndNewlines), provider: nil) }
                    }
                    .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.savingTaskID != nil)
                }

                catalogContent
            }
            .background(Color(.systemBackground))
            .navigationTitle(task?.label ?? String(localized: "Auxiliary Model"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await viewModel.loadCatalog() }
        }
        .adaptiveFormPresentation()
    }

    @ViewBuilder
    private var catalogContent: some View {
        let groups = viewModel.pickerGroups(matching: searchText)
        if viewModel.isLoadingCatalog && viewModel.catalogGroups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let error = viewModel.catalogErrorMessage, viewModel.catalogGroups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                Label("Could Not Load Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                SettingsFootnote(error)
            }
        } else if groups.isEmpty {
            SettingsSection(title: String(localized: "Models")) {
                Label("No Matching Models", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))
            }
        } else {
            ForEach(groups) { group in
                SettingsSection(title: group.name) {
                    Group {
                        ForEach(group.models) { model in
                            optionRow(title: model.displayName, subtitle: model.id == model.displayName ? nil : model.id, isSelected: model.id == task?.selectedOptionID) {
                                await save(model: model.id, provider: group.providerID)
                            }
                        }
                    }
                }
            }
        }
    }

    private func optionRow(title: String, subtitle: String?, isSelected: Bool, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            SettingsItemRow(title: title, subtitle: subtitle, isSelected: isSelected) {
                Image(systemName: "cpu").accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .disabled(viewModel.savingTaskID != nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func save(model: String, provider: String?) async {
        if await viewModel.save(task: taskID, model: model, provider: provider) {
            dismiss()
        }
    }
}
