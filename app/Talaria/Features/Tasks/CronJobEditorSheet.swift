import SwiftUI
import TalariaKit

struct CronJobEditorSheet: View {
    let title: String
    let saveTitle: String
    let isSaving: Bool
    let errorMessage: String?
    let onSave: (CronJobEditorDraft) async -> Bool

    @State private var draft: CronJobEditorDraft
    /// Model catalog, profile list, and skill list for the Configuration
    /// section. Loaded when this sheet opens, not when the task list appears.
    @State private var catalogs: CronJobEditorCatalogs
    @State private var isPresentingModelPicker = false
    @State private var isPresentingSkillsPicker = false
    @Environment(\.dismiss) private var dismiss

    /// Server-provided deliver targets. A plain `let` so a re-init while the
    /// sheet is presented (options finishing their async load) swaps in the
    /// fresh list, unlike `@State draft`, which keeps the user's edits.
    private let serverDeliveryOptions: [CronDeliveryOption]?
    /// The draft's deliver and profile values when the editor opened; stable
    /// across re-inits because callers rebuild the same draft.
    private let initialDeliver: String
    private let initialProfile: String

    /// Picker rows recomputed from the live draft so a value typed while the
    /// options were still loading keeps a matching row, and the initial
    /// unknown/legacy value keeps its custom row even after the user selects
    /// another option. `nil` means fall back to free-text entry.
    private var deliverPickerOptions: [CronDeliverPickerOption]? {
        CronDeliverPicker.options(
            serverOptions: serverDeliveryOptions,
            currentValue: draft.deliver,
            initialValue: initialDeliver
        )
    }

    /// Same rule as the deliver picker: `nil` (profiles unavailable) falls
    /// back to free text, and an unknown saved profile keeps a custom row.
    private var profilePickerOptions: [CronDeliverPickerOption]? {
        CronProfilePicker.options(
            profiles: catalogs.profiles,
            currentValue: draft.profile,
            initialValue: initialProfile
        )
    }

    init(
        title: String,
        client: APIClient,
        draft: CronJobEditorDraft,
        saveTitle: String,
        isSaving: Bool,
        errorMessage: String?,
        deliveryOptions: [CronDeliveryOption]? = nil,
        onSave: @escaping (CronJobEditorDraft) async -> Bool
    ) {
        self.title = title
        self.saveTitle = saveTitle
        self.isSaving = isSaving
        self.errorMessage = errorMessage
        self.onSave = onSave
        self.serverDeliveryOptions = deliveryOptions
        self.initialDeliver = draft.deliver
        self.initialProfile = draft.profile
        _draft = State(initialValue: draft)
        _catalogs = State(initialValue: CronJobEditorCatalogs(client: client))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("Name", text: $draft.name)

                    TextField("Prompt", text: $draft.prompt, axis: .vertical)
                        .lineLimit(3...8)

                    TextField("Schedule", text: $draft.schedule)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Delivery") {
                    if let deliverPickerOptions {
                        Picker("Deliver", selection: $draft.deliver) {
                            pickerRows(deliverPickerOptions)
                        }
                    } else {
                        TextField("Deliver", text: $draft.deliver)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    Toggle("Toast Notifications", isOn: $draft.toastNotifications)
                }

                Section {
                    pickerRow("Skills", value: skillsTitle, detail: nil) {
                        isPresentingSkillsPicker = true
                    }

                    pickerRow(
                        "Model",
                        value: modelSelection?.displayName ?? String(localized: "Server Default"),
                        detail: modelSelection?.providerID
                    ) {
                        isPresentingModelPicker = true
                    }

                    // Binding the profile straight to the draft leaves model
                    // and provider untouched: upstream fills the model in
                    // from the profile only while the model is blank, so
                    // prefilling here would suppress the server's own choice.
                    if let profilePickerOptions {
                        Picker("Profile", selection: $draft.profile) {
                            pickerRows(profilePickerOptions)
                        }
                    } else {
                        TextField("Profile", text: $draft.profile)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } header: {
                    Text("Configuration")
                } footer: {
                    if let catalogError = catalogs.errorMessage {
                        HStack(alignment: .firstTextBaseline) {
                            Text(verbatim: catalogError)
                                .foregroundStyle(.red)

                            Spacer(minLength: 8)

                            Button("Try Again") {
                                Task { await catalogs.load() }
                            }
                            .font(.footnote.weight(.semibold))
                        }
                    }
                }

                if let formMessage {
                    Section {
                        Text(formMessage)
                            .font(.footnote)
                            .foregroundStyle(messageColor)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await catalogs.load()
            }
            .sheet(isPresented: $isPresentingModelPicker) {
                // Favorites stay out of task editing: starring a model here
                // would silently change what the chat composer offers.
                ComposerModelPickerSheet(
                    modelGroups: catalogs.modelGroups,
                    selectedModelID: draft.trimmedModel,
                    selectedModelProviderID: draft.trimmedProvider,
                    selectedModelOptionID: draft.modelOptionID,
                    favoriteModelKeys: [],
                    recentModelKeys: [],
                    onSelect: { option in
                        draft.applyModelSelection(option)
                    },
                    onToggleFavorite: { _ in },
                    onDeleteSavedCustom: { _ in },
                    showsFavorites: false,
                    requiresCustomProviderID: false,
                    onClear: {
                        draft.applyModelSelection(nil)
                    }
                )
            }
            .sheet(isPresented: $isPresentingSkillsPicker) {
                CronJobSkillsPickerSheet(
                    skills: catalogs.skills,
                    selection: draft.skills,
                    isLoading: catalogs.isLoading,
                    errorMessage: catalogs.skillsErrorMessage,
                    onRetry: { Task { await catalogs.load() } },
                    onToggle: { name in
                        draft.toggleSkill(name)
                    }
                )
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .disabled(isSaving)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            if await onSave(draft) {
                                dismiss()
                            }
                        }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text(saveTitle)
                        }
                    }
                    .disabled(isSaving || draft.validationMessage != nil)
                }
            }
        }
        .adaptiveFormPresentation()
    }

    private var modelSelection: ModelCatalogOption? {
        draft.modelSelection(in: catalogs.modelGroups)
    }

    /// The selected names themselves rather than a count, so the row reads
    /// without opening the picker.
    private var skillsTitle: String {
        draft.skills.isEmpty ? String(localized: "None") : draft.skills.joined(separator: ", ")
    }

    private func pickerRows(_ options: [CronDeliverPickerOption]) -> some View {
        ForEach(options) { option in
            Group {
                if option.isCustom {
                    Text("\(option.label) (custom)")
                } else {
                    Text(option.label)
                }
            }
            .tag(option.value)
        }
    }

    /// A Form row that opens a picker sheet rather than pushing.
    private func pickerRow(
        _ label: LocalizedStringKey,
        value: String,
        detail: String?,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            LabeledContent {
                HStack(spacing: 6) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(verbatim: value)
                            .foregroundStyle(.primary)

                        if let detail, !detail.isEmpty {
                            Text(verbatim: detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)

                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            } label: {
                Text(label)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(Text(verbatim: [value, detail].compactMap { $0 }.joined(separator: ", ")))
    }

    private var formMessage: String? {
        errorMessage ?? draft.validationMessage
    }

    private var messageColor: Color {
        errorMessage == nil ? .secondary : .red
    }
}
