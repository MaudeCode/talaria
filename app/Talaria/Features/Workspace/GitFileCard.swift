import SwiftUI
import TalariaKit

struct GitFileCard: View {
    let file: GitFile

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(file.fileName)
                    .font(AppFont.subheadline(weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let parent = file.parentDirectory {
                    Text(parent)
                        .font(AppFont.mono(style: .caption2))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 6)
            DiffCountsLabel(additions: file.additions ?? 0, deletions: file.deletions ?? 0)
            GitStatusChip(kind: file.changeKind)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
