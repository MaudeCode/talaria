import SwiftUI
import TalariaKit

struct ComposerToolsetsSheet: View {
    let loadCatalog: (String) async throws -> ToolsetsCatalog?
    var errorMessage: String? = nil
    let onSave: ([String]?) async -> SessionToolsets

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: ToolsetsCatalog?
    @State private var selection: SessionToolsets?
    @State private var isAwaitingSelectionCatalog = false
    @State private var search = ""
    @State private var searchEnabled = false
    @State private var generation = 0
    @State private var loadFailed = false
    @State private var legacyEditor = false
    @State private var legacyInput: String

    init(toolsets: SessionToolsets = SessionToolsets(names: nil), errorMessage: String? = nil, loadCatalog: @escaping (String) async throws -> ToolsetsCatalog?, onSave: @escaping ([String]?) async -> SessionToolsets) {
        self.errorMessage = errorMessage
        self.loadCatalog = loadCatalog
        self.onSave = onSave
        _legacyInput = State(initialValue: toolsets.names?.joined(separator: ", ") ?? "")
    }

    var body: some View {
        NavigationStack {
            Group {
                if searchEnabled {
                    rows.searchable(text: $search)
                } else {
                    rows
                }
            }
            .navigationTitle("Toolsets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if legacyEditor { save(SessionToolsets.names(fromInput: legacyInput)) }
                        dismiss()
                    }
                }
            }
            .task(id: search) { await load() }
        }
    }

    private var rows: some View {
        List {
            if let errorMessage { Text(errorMessage).foregroundStyle(.secondary) }
            if loadFailed && catalog != nil {
                Text("Could not load toolsets.")
                Button("Retry") { Task { await load() } }
            }
            if let catalog {
                defaultsRow(isSelected: selection.map { $0.names == nil } ?? (catalog.usingDefaults == true))
                Section {
                    ForEach(catalog.toolsets) { item in
                        // Older catalogs predate the explicit group; availability was their policy field.
                        if item.group == "available" || (item.group == nil && item.available == true) {
                            Toggle(isOn: Binding(
                                get: { selectedNames(in: catalog).contains(item.name) },
                                set: { selected in
                                    let names = selectedNames(in: catalog)
                                    save(selected ? names + [item.name] : names.filter { $0 != item.name })
                                }
                            )) {
                                SettingsItemRow(title: item.name, subtitle: item.description, detail: strippedTools(item))
                            }
                            .disabled(isToolsetDisabled(item, in: catalog))
                            .accessibilityIdentifier("toolset-\(item.name)")
                        }
                    }
                }
                Section("Not available") {
                    ForEach(catalog.toolsets) { item in
                        if item.group == "not_available" || (item.group == nil && item.available != true) {
                            SettingsItemRow(title: item.name, subtitle: item.description, detail: strippedTools(item), accessory: {
                                Text(item.unavailableReason == "disabled" ? "Disabled by operator" : "Unavailable")
                                    .foregroundStyle(.secondary)
                            })
                            .disabled(true)
                            .accessibilityIdentifier("toolset-\(item.name)")
                        }
                    }
                }
            } else if legacyEditor {
                defaultsRow(isSelected: selection?.names == nil && legacyInput.isEmpty)
                TextField("tool1, tool2, …", text: $legacyInput)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { save(SessionToolsets.names(fromInput: legacyInput)) }
                    .accessibilityLabel("Session toolsets")
                    .accessibilityIdentifier("legacy-toolsets")
            } else if loadFailed {
                Text("Could not load toolsets.")
                Button("Retry") { Task { await load() } }
            } else {
                ProgressView("Loading toolsets…")
            }
        }
        .listStyle(.plain)
        .background(Color(.systemBackground))
    }

    private func defaultsRow(isSelected: Bool) -> some View {
        Button { save(nil) } label: {
            SettingsItemRow(title: String(localized: "Use profile defaults"), isSelected: isSelected, selectedSystemImage: "checkmark.circle.fill")
        }
        .accessibilityIdentifier("toolsets-defaults")
    }

    private func selectedNames(in catalog: ToolsetsCatalog) -> [String] {
        guard let selection else { return catalog.selectedToolsets }
        return selection.names ?? catalog.defaultToolsets ?? catalog.selectedToolsets
    }

    private func isToolsetDisabled(_ item: ToolsetChoice, in catalog: ToolsetsCatalog) -> Bool {
        guard item.available == true else { return true }
        if isAwaitingSelectionCatalog {
            // Preview only the user's own write until its server eligibility projection arrives.
            return selectedNames(in: catalog) == [item.name]
        }
        return selectedNames(in: catalog).contains(item.name) && item.canDeselect != true
    }

    private func strippedTools(_ item: ToolsetChoice) -> String? {
        guard let tools = item.strippedTools, !tools.isEmpty else { return nil }
        return String(localized: "Unavailable tools: \(tools.joined(separator: ", "))")
    }

    private func load() async {
        let query = search
        let revision = generation
        loadFailed = false
        do {
            let loaded = try await loadCatalog(query)
            guard !Task.isCancelled, query == search, revision == generation else { return }
            catalog = loaded
            isAwaitingSelectionCatalog = false
            legacyEditor = loaded == nil
            if query.isEmpty { searchEnabled = (loaded?.toolsets.count ?? 0) > 12 }
        } catch {
            if !Task.isCancelled, query == search, revision == generation { loadFailed = true }
        }
    }

    private func save(_ names: [String]?) {
        generation += 1
        let revision = generation
        selection = SessionToolsets(names: names)
        isAwaitingSelectionCatalog = true
        if legacyEditor { legacyInput = names?.joined(separator: ", ") ?? "" }
        let submittedInput = legacyInput
        Task {
            let confirmed = await onSave(names)
            guard revision == generation else { return }
            selection = confirmed
            isAwaitingSelectionCatalog = true
            if legacyEditor, legacyInput == submittedInput {
                legacyInput = confirmed.names?.joined(separator: ", ") ?? ""
            }
            await load()
        }
    }
}
