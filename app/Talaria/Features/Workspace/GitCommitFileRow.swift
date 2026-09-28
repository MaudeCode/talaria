import SwiftUI
import TalariaKit

struct GitCommitFileRow: View {
    let file: GitFile
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)

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

                if file.staged == true {
                    Text("Staged")
                        .font(AppFont.caption2(weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.green.opacity(0.18), in: Capsule())
                        .foregroundStyle(.green)
                }
                DiffCountsLabel(additions: file.additions ?? 0, deletions: file.deletions ?? 0)
                GitStatusChip(kind: file.changeKind)
            }
            .padding(12)
            .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isSelected ? Color.accentColor.opacity(0.5) : Color(.separator).opacity(0.35), lineWidth: isSelected ? 1 : 0.5)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
