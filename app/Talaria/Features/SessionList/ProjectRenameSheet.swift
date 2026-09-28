import SwiftUI
import TalariaKit

struct ProjectRenameSheet: View {
    let project: ProjectSummary
    let isSaving: Bool
    let onCancel: () -> Void
    let onSave: (String, String?) -> Void

    var body: some View {
        ProjectFormSheet(
            title: String(localized: "Rename Project"),
            initialName: project.name ?? "",
            initialColorHex: project.color,
            isSaving: isSaving,
            onCancel: onCancel,
            onSave: onSave
        )
    }
}
