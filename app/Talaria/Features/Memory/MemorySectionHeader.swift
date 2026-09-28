import SwiftUI
import TalariaKit

struct MemorySectionHeader: View {
    let section: MemorySection
    let modifiedAt: Date?
    let isEditingDisabled: Bool
    let onEdit: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Label(section.title, systemImage: section.systemImage)
            Spacer()
            if let modifiedAt {
                Text("Modified \(modifiedAt, style: .relative) ago")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button(action: onEdit) {
                Label("Edit \(section.title)", systemImage: "pencil")
                    .labelStyle(.iconOnly)
            }
            .disabled(isEditingDisabled)
            .buttonStyle(.borderless)
        }
    }
}
