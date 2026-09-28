import SwiftUI
import TalariaKit

struct KanbanBoardEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: KanbanFeatureState
    let mode: KanbanBoardEditorMode
    @State private var slug: String
    @State private var name: String
    @State private var description: String
    @State private var icon: String
    @State private var color: String
    @State private var showsSlugError = false
    @State private var showsNameError = false

    init(model: KanbanFeatureState, mode: KanbanBoardEditorMode) {
        self.model = model
        self.mode = mode
        switch mode {
        case .create:
            _slug = State(initialValue: "")
            _name = State(initialValue: "")
            _description = State(initialValue: "")
            _icon = State(initialValue: "")
            _color = State(initialValue: "")
        case let .edit(board):
            _slug = State(initialValue: board.slug ?? "")
            _name = State(initialValue: board.name ?? "")
            _description = State(initialValue: board.description ?? "")
            _icon = State(initialValue: board.icon ?? "")
            _color = State(initialValue: board.color ?? "")
        }
    }

    var body: some View {
        Form {
            Section {
                TextField("Slug", text: $slug)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(isEditing)
                    .accessibilityHint(Text("The slug cannot be changed after the Board is created."))
                if showsSlugError {
                    Text("Required")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                TextField("Name", text: $name)
                if showsNameError {
                    Text("Required")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                TextField("Description", text: $description, axis: .vertical)
                    .lineLimit(2...5)
                TextField("Icon", text: $icon)
                TextField("Color", text: $color)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                Text("Creating a Board does not make it active.")
            }

            if let mutation = model.boardMutationState,
               mutation.kind.slug == slug,
               mutation.phase == .failed || mutation.phase == .outcomeUncertain {
                Section {
                    Text(mutation.phase == .failed ? "Failed" : "Outcome Uncertain")
                        .foregroundStyle(.red)
                    Text("Refresh the Board before trying again.")
                        .font(.footnote)
                }
            }
        }
        .navigationTitle(isEditing ? "Edit" : "Create")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { submit() }
                    .disabled(!model.canManageBoards)
            }
        }
    }

    private var isEditing: Bool {
        if case .edit = mode { true } else { false }
    }

    private func submit() {
        let trimmedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        showsSlugError = trimmedSlug.isEmpty
        showsNameError = trimmedName.isEmpty
        guard !showsSlugError, !showsNameError else { return }
        Task {
            if isEditing {
                await model.editBoard(KanbanEditBoardRequest(
                    slug: trimmedSlug,
                    name: trimmedName,
                    description: description,
                    icon: icon,
                    color: color
                ))
            } else {
                await model.createBoard(KanbanCreateBoardRequest(
                    slug: trimmedSlug,
                    name: trimmedName,
                    description: description,
                    icon: icon,
                    color: color
                ))
            }
            if model.boardMutationState?.phase == .succeeded {
                dismiss()
            }
        }
    }
}
