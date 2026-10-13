import SwiftUI
import TalariaKit

struct ComposerToolsetsSheet: View {
    let loadCatalog: () async throws -> ToolsetsCatalog?
    let onSave: ([String]?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: ToolsetsCatalog?
    @State private var draft: [String]?
    @State private var loadFailed = false
    @State private var legacyEditor = false
    @State private var legacyInput: String

    init(toolsets: SessionToolsets = SessionToolsets(names: nil), loadCatalog: @escaping () async throws -> ToolsetsCatalog?, onSave: @escaping ([String]?) async -> Void) {
        self.loadCatalog = loadCatalog
        self.onSave = onSave
        _legacyInput = State(initialValue: toolsets.names?.joined(separator: ", ") ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                if let catalog {
                    Section {
                        ForEach(catalog.toolsets) { item in
                            Toggle(isOn: Binding(
                                get: { draft.map { $0.contains(item.name) } ?? (item.selected == true) },
                                set: { selected in
                                    let names = draft ?? catalog.selectedToolsets
                                    draft = selected ? names + [item.name] : names.filter { $0 != item.name }
                                }
                            )) {
                                VStack(alignment: .leading) {
                                    Text(item.name)
                                    if item.available != true {
                                        Text(item.unavailableReason == "disabled" ? "Disabled by operator" : "Unavailable")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .disabled(item.available != true)
                            .accessibilityIdentifier("toolset-\(item.name)")
                        }
                    }
                } else if legacyEditor {
                    Section {
                        TextField("tool1, tool2, …", text: $legacyInput)
                            .font(.body.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit { save(SessionToolsets.names(fromInput: legacyInput)) }
                            .accessibilityLabel("Session toolsets")
                            .accessibilityIdentifier("legacy-toolsets")
                    } footer: {
                        Text("Comma-separated toolset names; empty restores the profile default.")
                    }
                } else if loadFailed {
                    Section {
                        Text("Could not load toolsets.")
                        Button("Retry") { Task { await load() } }
                    }
                } else {
                    ProgressView("Loading toolsets…")
                }
                if catalog != nil || legacyEditor {
                    Section {
                        Button("Use profile defaults") { save(nil) }
                    }
                }
            }
            .navigationTitle("Session toolsets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if legacyEditor {
                            save(SessionToolsets.names(fromInput: legacyInput))
                        } else if let catalog {
                            save(draft ?? (catalog.usingDefaults == true ? nil : catalog.selectedToolsets))
                        }
                    }
                    .disabled(!legacyEditor && (catalog == nil || (draft ?? catalog?.selectedToolsets ?? []).isEmpty))
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loadFailed = false
        legacyEditor = false
        do {
            catalog = try await loadCatalog()
            legacyEditor = catalog == nil
        } catch { loadFailed = true }
    }

    private func save(_ names: [String]?) {
        Task { await onSave(names) }
    }
}
