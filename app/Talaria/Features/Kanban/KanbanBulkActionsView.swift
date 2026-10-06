import SwiftUI
import TalariaKit

struct KanbanBulkActionsView: View {
    @Environment(\.dismiss) private var dismiss
    let model: KanbanFeatureState
    let onArchive: () -> Void
    let onFinished: () -> Void
    @State private var status = "todo"
    @State private var profile: String?
    @State private var priority = 0

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(KanbanCountFormatter.cards(model.selectedCardCount))
                        .font(.headline)
                }

                Section("Change Status") {
                    Picker("Status", selection: $status) {
                        ForEach(statusOptions, id: \.self) { value in
                            Text(KanbanStatusPresentation(value).title).tag(value)
                        }
                    }
                    Button("Change Status") {
                        submit(.changeStatus(status))
                    }
                    .disabled(!model.canSubmitBulkAction(.changeStatus(status)))
                    .frame(minHeight: 44)
                }

                Section("Assign Profile") {
                    Picker("Profile", selection: $profile) {
                        Text("Unassigned").tag(String?.none)
                        ForEach(model.profileOptions, id: \.self) { value in
                            Text(value).tag(Optional(value))
                        }
                    }
                    Button("Assign Profile") {
                        submit(.assignProfile(profile))
                    }
                    .disabled(!model.canSubmitBulkAction(.assignProfile(profile)))
                    .frame(minHeight: 44)
                }

                Section("Set Priority") {
                    Stepper(value: $priority, in: -100...100) {
                        HStack {
                            Text("Priority")
                            Text(verbatim: "\(priority)")
                        }
                    }
                    Button("Set Priority") {
                        submit(.setPriority(priority))
                    }
                    .disabled(!model.canSubmitBulkAction(.setPriority(priority)))
                    .frame(minHeight: 44)
                }

                Section {
                    Button("Archive Cards", role: .destructive) {
                        onArchive()
                    }
                    .disabled(!model.canSubmitBulkAction(.archiveCards))
                    .frame(minHeight: 44)
                }
            }
            .navigationTitle("Bulk Actions")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.bulkActionPhase != nil)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.bulkActionPhase != nil)
                }
            }
        }
    }

    private var statusOptions: [String] { model.bulkMoveTargets }

    private func submit(_ action: KanbanBulkAction) {
        Task {
            await model.performBulkAction(action)
            onFinished()
        }
    }
}
