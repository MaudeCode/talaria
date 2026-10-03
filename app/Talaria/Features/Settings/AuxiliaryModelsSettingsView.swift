import SwiftUI
import TalariaKit

/// Settings > Servers > Auxiliary Models (TAL-388): the server's side-task
/// slots in server order. Tapping a task opens a searchable model sheet.
struct AuxiliaryModelsSettingsView: View {
    let server: URL

    @State private var viewModel: AuxiliaryModelsViewModel
    @State private var editingTask: AuxiliaryModelTask?
    @State private var isConfirmingReset = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(server: URL) {
        self.server = server
        _viewModel = State(initialValue: AuxiliaryModelsViewModel(server: server))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                content
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.systemGroupedBackground))
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
            SettingsCard(title: String(localized: "Auxiliary Models")) {
                Label("Not Available on This Server", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                SettingsFootnote(String(localized: "Update the Talaria Web server to choose models for side tasks."))
            }
        } else if viewModel.tasks.isEmpty, viewModel.isLoading || viewModel.errorMessage == nil {
            SettingsCard(title: String(localized: "Tasks")) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading auxiliary models...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if viewModel.tasks.isEmpty, let errorMessage = viewModel.errorMessage {
            SettingsCard(title: String(localized: "Tasks")) {
                Label("Could Not Load Auxiliary Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                SettingsFootnote(errorMessage)
                SettingsButton(String(localized: "Try Again")) {
                    Task { await viewModel.load() }
                }
            }
        } else {
            SettingsFootnote(String(localized: "Models for side tasks such as session titles, vision, and compression. Auto uses the main model."))

            SettingsCard(title: String(localized: "Tasks")) {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.tasks.enumerated()), id: \.element.id) { index, task in
                        taskRow(task)
                        if index < viewModel.tasks.count - 1 {
                            Divider()
                        }
                    }
                }
            }

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

    private func taskRow(_ task: AuxiliaryModelTask) -> some View {
        Button {
            viewModel.clearSaveError()
            editingTask = task
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(task.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AuxiliaryModelValueText(task: task)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                }
                Spacer(minLength: 12)
                Image(systemName: "chevron.forward")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var task: AuxiliaryModelTask? { viewModel.task(id: taskID) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    SettingsPickerSearchField(text: $searchText, prompt: "Search models", clearLabel: "Clear model search")

                    if let saveError = viewModel.saveErrorMessage {
                        Text(saveError)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if let task {
                        SettingsCard(title: String(localized: "Current")) {
                            VStack(spacing: 0) {
                                optionRow(title: String(localized: "Auto"), subtitle: String(localized: "Use the main model"), isSelected: task.isAuto == true) {
                                    await save(model: "", provider: "auto")
                                }
                                if task.inCatalog == false {
                                    Divider()
                                    optionRow(title: task.valueLabel ?? task.model, subtitle: [task.providerLabel, String(localized: "Not in catalog")].compactMap { $0 }.joined(separator: " · "), isSelected: true) {
                                        await save(model: task.model, provider: task.provider)
                                    }
                                }
                            }
                        }
                    }

                    SettingsCard(title: String(localized: "Custom")) {
                        TextField("Custom model ID", text: $customModel)
                            .font(.subheadline)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
                .padding()
            }
            .background(Color(.systemGroupedBackground))
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
            SettingsCard(title: String(localized: "Models")) {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let error = viewModel.catalogErrorMessage, viewModel.catalogGroups.isEmpty {
            SettingsCard(title: String(localized: "Models")) {
                Label("Could Not Load Models", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                SettingsFootnote(error)
            }
        } else if groups.isEmpty {
            SettingsCard(title: String(localized: "Models")) {
                Label("No Matching Models", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))
            }
        } else {
            ForEach(groups) { group in
                SettingsCard(title: group.name) {
                    VStack(spacing: 0) {
                        ForEach(Array(group.models.enumerated()), id: \.element.id) { index, model in
                            optionRow(title: model.displayName, subtitle: model.id == model.displayName ? nil : model.id, isSelected: model.id == task?.selectedOptionID) {
                                await save(model: model.id, provider: group.providerID)
                            }
                            if index < group.models.count - 1 {
                                Divider()
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
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    }
                }
                Spacer(minLength: 12)
                if isSelected {
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
