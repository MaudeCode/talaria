import SwiftUI
import TalariaKit

struct WorkspaceAddSheet: View {
    let viewModel: WorkspaceRegistryViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var name = ""
    @State private var createIfMissing = false
    @State private var suggestions: [String] = []
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Workspace path", text: $path)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Name (optional)", text: $name)

                    Toggle("Create the folder if it doesn't exist", isOn: $createIfMissing)
                } footer: {
                    Text("Suggestions are limited to trusted workspace roots from the server.")
                }

                if let errorMessage = viewModel.errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if !filteredSuggestions.isEmpty {
                    Section("Suggestions") {
                        ForEach(filteredSuggestions, id: \.self) { suggestion in
                            Button {
                                path = suggestion
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "folder")
                                        .foregroundStyle(Color(.secondaryLabel))
                                    Text(suggestion)
                                        .font(.callout)
                                        .foregroundStyle(.primary)
                                        .lineLimit(2)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Add Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add") {
                        submit()
                    }
                    .disabled(trimmedPath.isEmpty || isSubmitting)
                }
            }
            .task(id: path) {
                if !path.isEmpty {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                }
                suggestions = await viewModel.loadSuggestions(prefix: path)
            }
        }
        .adaptiveFormPresentation()
    }

    private var trimmedPath: String {
        path.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredSuggestions: [String] {
        var seen = Set<String>()
        return suggestions.filter { !$0.isEmpty && $0 != trimmedPath && seen.insert($0).inserted }
    }

    private func submit() {
        guard !trimmedPath.isEmpty, !isSubmitting else { return }
        isSubmitting = true
        Task { @MainActor in
            let succeeded = await viewModel.addWorkspace(path: trimmedPath, name: name, create: createIfMissing)
            isSubmitting = false
            if succeeded {
                dismiss()
            }
        }
    }
}
