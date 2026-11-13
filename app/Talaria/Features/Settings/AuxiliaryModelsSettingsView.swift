import SwiftUI
import TalariaKit

/// Settings > Servers > Auxiliary Models (TAL-388): the server's side-task
/// slots in server order. Tapping a task pushes the shared model picker.
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
        .task { await viewModel.load() }
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
            SettingsModelPickerPage(
                title: task.label, server: server,
                isSelected: { $0.id == viewModel.task(id: task.task)?.selectedOptionID },
                isSavingModel: { _ in false }, isSaving: viewModel.savingTaskID != nil,
                saveError: viewModel.saveErrorMessage,
                customHelp: String(localized: "Use @provider:model to pin a provider."),
                onSelect: { await viewModel.save(task: task.task, model: $0, provider: $1) },
                onSaveCustom: { await viewModel.save(task: task.task, model: $0, provider: nil) }
            ) { select in
                if let current = viewModel.task(id: task.task) {
                    SettingsSection(title: String(localized: "Current"), help: String(localized: "Use the main model")) {
                        Group {
                            currentOption(title: String(localized: "Auto"), isSelected: current.isAuto == true) {
                                await select("", "auto")
                            }
                            if current.inCatalog == false {
                                SettingsDivider()
                                currentOption(title: current.valueLabel ?? current.model,
                                              subtitle: [current.providerLabel, String(localized: "Not in catalog")].compactMap { $0 }.joined(separator: " · "),
                                              isSelected: true) {
                                    await select(current.model, current.provider)
                                }
                            }
                        }
                    }
                }
            }
            .task {
                viewModel.clearSaveError()
            }
        } label: {
            SettingsItemRow(title: task.label, accessorySystemImage: "chevron.forward") {
                Image(systemName: "cpu").accessibilityHidden(true)
            } badges: {
                AuxiliaryModelValueText(task: task)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the model picker for this task.")
    }

    private func currentOption(title: String, subtitle: String? = nil, isSelected: Bool,
                               action: @escaping () async -> Void) -> some View {
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
