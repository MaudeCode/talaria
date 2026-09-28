import SwiftUI
import TalariaKit

struct KanbanFiltersView: View {
    @Environment(\.dismiss) private var dismiss
    let model: KanbanFeatureState
    @State private var draft: KanbanFiltersDraft

    init(model: KanbanFeatureState) {
        self.model = model
        _draft = State(initialValue: KanbanFiltersDraft(model: model))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    Picker("Assigned Profile", selection: $draft.profile) {
                        Text("All Profiles").tag(String?.none)
                        ForEach(model.profileOptions, id: \.self) { value in
                            Text(value).tag(Optional(value))
                        }
                    }
                    .disabled(draft.onlyMine)
                    Toggle("Only Mine", isOn: $draft.onlyMine)
                        .onChange(of: draft.onlyMine) { _, enabled in
                            if enabled { draft.profile = nil }
                        }
                }

                Section("Tenant") {
                    Picker("Tenant", selection: $draft.tenant) {
                        Text("All Tenants").tag(String?.none)
                        ForEach(model.tenantOptions, id: \.self) { value in
                            Text(value).tag(Optional(value))
                        }
                    }
                }

                Section("Archived Cards") {
                    Toggle("Include Archived Cards", isOn: $draft.includesArchived)
                }

                Section("Display") {
                    Toggle("Group by Profile", isOn: $draft.groupsByProfile)
                }

                if model.hasActiveFilters {
                    Section {
                        Button("Clear Filters", role: .destructive) {
                            Task {
                                await model.clearFilters()
                                dismiss()
                            }
                        }
                        .frame(minHeight: 44)
                    }
                }
            }
            .navigationTitle("Card Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        Task {
                            await draft.apply(to: model)
                            dismiss()
                        }
                    }
                }
            }
        }
    }
}
