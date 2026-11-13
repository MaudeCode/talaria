import SwiftUI
import TalariaKit

/// Settings > Servers > Auxiliary Models (TAL-388): the server's side-task
/// slots in server order. A task editor reuses the shared model picker.
struct AuxiliaryModelsSettingsView: View {
    let server: URL

    @State private var viewModel: AuxiliaryModelsViewModel
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
        .task { await viewModel.loadIfNeeded() }
        .refreshesLive(showsStatus: !viewModel.tasks.isEmpty) { await viewModel.load() }
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
        } else if viewModel.tasks.isEmpty, viewModel.isLoading {
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
        } else if viewModel.tasks.isEmpty {
            SettingsSection(title: String(localized: "Tasks")) {
                SettingsInfoRow(title: String(localized: "No Tasks"), value: "")
            }
        } else {
            if let error = viewModel.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
            SettingsSection(
                title: String(localized: "Tasks"),
                help: ([String(localized: "Models for side tasks such as session titles, vision, and compression. Auto uses the main model.")]
                    + viewModel.tasks.map { "\($0.label): \($0.description)" }).joined(separator: "\n\n")
            ) {
                ForEach(viewModel.tasks) { task in
                    taskRow(task)
                }

                if let saveError = viewModel.saveErrorMessage {
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
        NavigationLink {
            AuxiliaryModelTaskEditor(server: server, viewModel: viewModel, taskID: task.task)
        } label: {
            SettingsItemRow(title: task.label, subtitle: auxiliaryModelLabel(task),
                detail: [task.reasoning.map(auxiliaryReasoningLabel), task.inCatalog == false ? String(localized: "Not in catalog") : nil]
                    .compactMap { $0 }.joined(separator: " · "), accessorySystemImage: "chevron.forward") {
                Image(systemName: "cpu").accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

private func auxiliaryModelLabel(_ task: AuxiliaryModelTask) -> String {
    let model = [task.providerLabel, task.valueLabel].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    return task.isAuto == true ? (model.isEmpty ? String(localized: "Auto") : String(localized: "Auto · \(model)")) : model
}

/// A task has one local draft; its model choice uses the same Settings picker as Default Model.
private struct AuxiliaryModelTaskEditor: View {
    let server: URL
    @Bindable var viewModel: AuxiliaryModelsViewModel
    let taskID: String
    @Environment(\.dismiss) private var dismiss
    @State private var started = false
    @State private var isPickingModel = false

    var body: some View {
        SettingsPage(title: viewModel.task(id: taskID)?.label ?? taskID) {
            if let draft = viewModel.draft, draft.original.task == taskID {
                SettingsSection(title: String(localized: "Model")) {
                    Button { isPickingModel = true } label: {
                        SettingsItemRow(title: String(localized: "Model"), subtitle: [draft.provider ?? draft.original.providerLabel, draft.modelLabel].compactMap { $0 }.joined(separator: " · "),
                                        accessorySystemImage: "chevron.forward")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("auxiliary-edit-model")
                }
                SettingsSection(title: String(localized: "Reasoning")) {
                    if let options = draft.options, !options.isEmpty {
                        SettingsPickerRow(title: String(localized: "Reasoning"), systemImage: "brain",
                            selection: Binding(get: { draft.model != nil && !draft.writesReasoning ? "__keep__" : draft.effort }, set: {
                                if $0 == "__keep__" { viewModel.preserveReasoning() } else { viewModel.selectEffort($0) }
                            }),
                            accessibilityIdentifier: "auxiliary-edit-reasoning") {
                            if draft.model != nil { Text("Keep if Supported").tag(Optional("__keep__")) }
                            Text(defaultLabel(draft.original.reasoning)).tag(String?.none)
                            ForEach(options, id: \.self) { effort in
                                Text(ReasoningEffortOption.title(for: effort)).tag(Optional(effort))
                            }
                        }
                    } else {
                        SettingsInfoRow(title: String(localized: "Reasoning"), value: draft.isLoadingCapability
                            ? String(localized: "Loading") : String(localized: "Unavailable"))
                    }
                    if let reasoning = draft.original.reasoning {
                        SettingsInfoRow(title: String(localized: "Saved"), value: auxiliaryReasoningLabel(reasoning))
                        if let effective = reasoning.effective {
                            SettingsInfoRow(title: String(localized: "Effective"), value: effective.isEmpty
                                ? defaultLabel(reasoning) : ReasoningEffortOption.title(for: effective))
                        }
                    }
                    if let error = draft.capabilityError { SettingsErrorFootnote(SettingsErrorText(error)) }
                }
                if let error = viewModel.saveErrorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
            }
        }
        .navigationTitle(viewModel.task(id: taskID)?.label ?? taskID)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { viewModel.cancelEditing(); dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { if await viewModel.saveDraft() { dismiss() } } }
                    .disabled(viewModel.draft?.hasChanges != true || viewModel.savingTaskID != nil)
                    .accessibilityIdentifier("auxiliary-edit-save")
            }
        }
        .navigationDestination(isPresented: $isPickingModel) { picker }
        .onAppear {
            if !started { viewModel.beginEditing(task: taskID); started = true }
        }
        .onDisappear { if !isPickingModel { viewModel.cancelEditing() } }
    }

    private func chooseModel(_ model: String, provider: String?, label: String? = nil) -> Bool {
        let editID = viewModel.draft?.id
        Task {
            guard viewModel.draft?.id == editID else { return }
            await viewModel.selectModel(model, provider: provider, label: label)
        }
        return true
    }

    private var picker: some View {
        SettingsModelPickerPage(title: String(localized: "Model"), server: server,
            isSelected: { option in
                guard let draft = viewModel.draft else { return false }
                return DefaultModelPickerSelection.isChecked(option, selectedModel: draft.model,
                    selectedProvider: draft.provider, defaultOptionID: draft.original.selectedOptionID, defaultModel: nil)
            }, isSavingModel: { _ in false }, isSaving: false, saveError: nil,
            customHelp: String(localized: "Use @provider:model to pin a provider."),
            onSelect: { chooseModel($0, provider: $1) },
            onSaveCustom: { chooseModel($0, provider: nil) }, catalog: viewModel.catalog,
            onSelectOption: { chooseModel($0.id, provider: $0.providerID, label: $0.displayName) }
        ) { select in
            SettingsSection(title: String(localized: "Current")) {
                Button { Task { await select("", "auto") } } label: {
                    SettingsItemRow(title: String(localized: "Auto"), isSelected: viewModel.draft?.model == ""
                        || viewModel.draft?.model == nil && viewModel.draft?.original.isAuto == true)
                }.buttonStyle(.plain)
                if let current = viewModel.draft?.original, current.inCatalog == false {
                    let selected = viewModel.draft?.model == nil
                        || viewModel.draft?.model == current.model && viewModel.draft?.provider == current.provider
                    Button { Task { await select(current.model, current.provider) } } label: {
                        SettingsItemRow(title: current.valueLabel ?? current.model,
                            subtitle: String(localized: "Not in catalog"),
                            isSelected: selected)
                    }.buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }
}

private func defaultLabel(_ reasoning: AuxiliaryReasoning?) -> String {
    switch reasoning?.defaultSource {
    case "parent": String(localized: "Inherit from Parent")
    case "provider": String(localized: "Provider Default")
    default: String(localized: "Default")
    }
}

private func auxiliaryReasoningLabel(_ reasoning: AuxiliaryReasoning) -> String {
    if reasoning.inherited == true { return defaultLabel(reasoning) }
    return reasoning.saved.map { ReasoningEffortOption.title(for: $0) } ?? String(localized: "Unknown")
}
