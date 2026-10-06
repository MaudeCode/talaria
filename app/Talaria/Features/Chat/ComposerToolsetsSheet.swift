import SwiftUI
import TalariaKit

/// Sets the session's toolsets, like Web's toolsets control (TAL-631): comma-separated names, or the
/// profile's defaults.
struct ComposerToolsetsSheet: View {
    let onSave: ([String]?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var input: String

    init(toolsets: SessionToolsets, onSave: @escaping ([String]?) async -> Void) {
        self.onSave = onSave
        _input = State(initialValue: toolsets.names?.joined(separator: ", ") ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("tool1, tool2, …", text: $input)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { save(SessionToolsets.names(fromInput: input)) }
                        .accessibilityLabel("Session toolsets")
                } footer: {
                    Text("Comma-separated toolset names; empty restores the profile default.")
                }

                Section {
                    Button("Use profile defaults") { save(nil) }
                }
            }
            .navigationTitle("Session toolsets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(SessionToolsets.names(fromInput: input)) }
                }
            }
        }
    }

    /// The sheet closes on save; a failure reports in the composer and keeps the old value.
    private func save(_ names: [String]?) {
        Task { await onSave(names) }
    }
}
