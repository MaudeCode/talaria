import SwiftUI

struct ProjectContextSectionHeader: View {
    let modifiedAt: Date?

    var body: some View {
        MemoryHeaderRow(title: String(localized: "Project Context"), systemImage: "folder.badge.gearshape", modifiedAt: modifiedAt) {
            Image(systemName: "lock.fill")
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text("Read-only"))
        }
    }
}
