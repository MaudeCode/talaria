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
