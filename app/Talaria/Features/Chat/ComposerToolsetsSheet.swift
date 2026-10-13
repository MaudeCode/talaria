import SwiftUI
import TalariaKit

struct ComposerToolsetsSheet: View {
    let loadCatalog: () async throws -> ToolsetsCatalog
    let onSave: ([String]?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: ToolsetsCatalog?
    @State private var draft: [String]?
    @State private var loadFailed = false

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
                    Section {
                        Button("Use profile defaults") { save(nil) }
                    }
                } else if loadFailed {
                    Section {
                        Text("Could not load toolsets.")
                        Button("Retry") { Task { await load() } }
                    }
                } else {
                    ProgressView("Loading toolsets…")
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
                        guard let catalog else { return }
                        save(draft ?? (catalog.usingDefaults == true ? nil : catalog.selectedToolsets))
                    }
                    .disabled(catalog == nil || (draft ?? catalog?.selectedToolsets ?? []).isEmpty)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loadFailed = false
        do { catalog = try await loadCatalog() }
        catch { loadFailed = true }
    }

    private func save(_ names: [String]?) {
        Task { await onSave(names) }
    }
}
