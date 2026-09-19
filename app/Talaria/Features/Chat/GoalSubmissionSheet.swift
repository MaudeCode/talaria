import SwiftUI

struct GoalSubmissionSheet: View {
    @Environment(\.dismiss) private var dismiss

    @Binding var goalDraft: String
    let isSubmitting: Bool
    let onSubmit: (String) -> Void

    var body: some View {
        NavigationStack {
            TextEditor(text: $goalDraft)
                .font(.body)
                .padding()
                .scrollContentBackground(.hidden)
                .background(Color(.systemGroupedBackground))
                .navigationTitle("Set Goal")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Set") {
                            let submittedGoal = goalDraft
                            dismiss()
                            onSubmit(submittedGoal)
                        }
                        .disabled(goalDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .adaptiveFormPresentation()
    }
}
