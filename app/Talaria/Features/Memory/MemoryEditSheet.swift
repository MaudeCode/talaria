import SwiftUI
import TalariaKit

struct MemoryEditSheet: View {
    let section: MemorySection
    let isSaving: Bool
    let errorMessage: String?
    /// Set when the save was refused because the file changed since it loaded (TAL-784).
    let onReload: (() -> Void)?
    let onSave: (String) async -> Bool

    @State private var content: String
    @Environment(\.dismiss) private var dismiss

    init(
        section: MemorySection,
        initialContent: String,
        isSaving: Bool,
        errorMessage: String?,
        onReload: (() -> Void)? = nil,
        onSave: @escaping (String) async -> Bool
    ) {
        self.section = section
        self.isSaving = isSaving
        self.errorMessage = errorMessage
        self.onReload = onReload
        self.onSave = onSave
        _content = State(initialValue: initialContent)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(section.title) {
                    TextEditor(text: $content)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 320)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isSaving)
                        .accessibilityLabel(section.title)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                        if let onReload {
                            Button("Reload") {
                                dismiss()
                                onReload()
                            }
                        }
                    }
                }
            }
            .navigationTitle("Edit \(section.title)")
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
                            if await onSave(content) {
                                dismiss()
                            }
                        }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(isSaving)
                }
            }
        }
        .adaptiveFormPresentation()
    }
}
