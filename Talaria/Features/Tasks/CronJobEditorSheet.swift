import SwiftUI

struct CronJobEditorSheet: View {
    let title: String
    let saveTitle: String
    let isSaving: Bool
    let errorMessage: String?
    let onSave: (CronJobEditorDraft) async -> Bool

    @State private var draft: CronJobEditorDraft
    @Environment(\.dismiss) private var dismiss

    /// Server-provided deliver targets. A plain `let` so a re-init while the
    /// sheet is presented (options finishing their async load) swaps in the
    /// fresh list, unlike `@State draft`, which keeps the user's edits.
    private let serverDeliveryOptions: [CronDeliveryOption]?
    /// The draft's deliver value when the editor opened; stable across
    /// re-inits because callers rebuild the same draft.
    private let initialDeliver: String

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

    init(
        title: String,
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
        _draft = State(initialValue: draft)
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
                            ForEach(deliverPickerOptions) { option in
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
                    } else {
                        TextField("Deliver", text: $draft.deliver)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    Toggle("Toast Notifications", isOn: $draft.toastNotifications)
                }

                Section("Configuration") {
                    TextField("Skills", text: $draft.skillsText, axis: .vertical)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Model", text: $draft.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Provider", text: $draft.provider)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Profile", text: $draft.profile)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
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

    private var formMessage: String? {
        errorMessage ?? draft.validationMessage
    }

    private var messageColor: Color {
        errorMessage == nil ? .secondary : .red
    }
}
