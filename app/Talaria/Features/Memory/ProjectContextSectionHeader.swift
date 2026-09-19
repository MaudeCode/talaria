import SwiftUI

struct ProjectContextSectionHeader: View {
    let modifiedAt: Date?

    var body: some View {
        HStack(spacing: 8) {
            Label("Project Context", systemImage: "folder.badge.gearshape")
            Spacer()
            if let modifiedAt {
                Text("Modified \(modifiedAt, style: .relative) ago")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Image(systemName: "lock.fill")
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text("Read-only"))
        }
    }
}
