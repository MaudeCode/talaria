import SwiftUI
import TalariaKit

struct DiffLineRow: View {
    let line: DiffLine

    var body: some View {
        HStack(spacing: 0) {
            Text(line.gutterLabel)
                .font(AppFont.mono(style: .caption))
                .foregroundStyle(.secondary)
                .frame(width: 48, alignment: .trailing)
                .padding(.trailing, 8)
                .background(line.kind.gutterBackground)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(line.kind == .context ? .secondary : .primary)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 19)
        .background(line.kind.rowBackground)
    }
}

/// A file edit's change (TAL-448): its hunks under their `@@` labels, and a note when the server cut the diff short.
/// A tool card and the companion page (TAL-1458) show an edit this one way.
struct EditDiffHunks: View {
    let editDiff: ToolEditDiff

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(editDiff.hunks) { hunk in
                    Text(hunk.displayLabel)
                        .font(AppFont.mono(style: .caption))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemBackground))
                    ForEach(hunk.lines) { DiffLineRow(line: $0) }
                }
            }
            .textSelection(.enabled)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

            if editDiff.truncated {
                Text("Diff truncated")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
    }
}
