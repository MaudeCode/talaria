import SwiftUI
import TalariaKit

struct GitStatusChip: View {
    let kind: GitFile.ChangeKind

    var body: some View {
        if let label {
            Text(label)
                .font(AppFont.caption2(weight: .semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(tint.opacity(0.18), in: Capsule())
                .foregroundStyle(tint)
        }
    }

    private var label: String? {
        switch kind {
        case .modified: return String(localized: "Modified")
        case .added: return String(localized: "Added")
        case .deleted: return String(localized: "Deleted")
        case .renamed: return String(localized: "Renamed")
        case .untracked: return String(localized: "Untracked")
        case .conflict: return String(localized: "Conflict")
        case .ignored, .unknown: return nil
        }
    }

    private var tint: Color {
        switch kind {
        case .added, .untracked: return .green
        case .deleted: return .red
        case .renamed: return .blue
        case .conflict: return .orange
        case .modified: return .yellow
        case .ignored, .unknown: return .secondary
        }
    }
}
