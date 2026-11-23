import SwiftUI
import TalariaKit

/// TAL-2323: a file path as the Agent wrote it; a link opening the file (at `line`) when the server located it inside the
/// session workspace.
private struct ToolFilePath: View {
    let path: String
    let focusPath: String?
    let line: Int?
    @Environment(\.chatOpenWorkspaceFile) private var openFile

    var body: some View {
        Group {
            if let focusPath, let openFile {
                Button {
                    openFile(WorkspaceFileLink(path: focusPath, line: line))
                } label: {
                    label.foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(openLabel)
            } else {
                label.foregroundStyle(.primary)
            }
        }
        .contextMenu {
            if let focusPath, let openFile {
                Button(openLabel) { openFile(WorkspaceFileLink(path: focusPath, line: line)) }
            }
            Button(String(localized: "Copy file path")) { PlatformHooks.copyText(path) }
        }
    }

    private var openLabel: String {
        line.map { String(localized: "Open \(path) at line \($0)") } ?? String(localized: "Open \(path)")
    }

    private var label: some View {
        Text(verbatim: path)
            .font(AppFont.mono(style: .caption, weight: .semibold))
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .contentShape(Rectangle())
    }
}

/// TAL-2323: a read's lines under its path, coloured by the source viewer's highlighter with the grammar the server
/// named, numbered as in the file, and where a cut-short read stopped. TAL-2594: an archive read that wrapped its long
/// lines says so, since its numbers count wrapped lines.
struct FileExcerptSection: View {
    let excerpt: FileExcerpt
    @Environment(\.colorScheme) private var colorScheme
    @State private var coloured: [SourceLine] = []

    private struct HighlightRequest: Equatable {
        let excerpt: FileExcerpt
        let isDark: Bool
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // TAL-2328: code a call ran has no path.
            if !excerpt.path.isEmpty {
                ToolFilePath(path: excerpt.path, focusPath: excerpt.focusPath, line: excerpt.startLine)
            }
            if !excerpt.lines.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(excerpt.lines.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(verbatim: String(line.n))
                                .foregroundStyle(.secondary)
                                .frame(minWidth: gutterWidth, alignment: .trailing)
                                .accessibilityLabel(String(localized: "Line \(line.n)"))
                            text(index, line)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .font(AppFont.mono(style: .caption))
                .textSelection(.enabled)
                .padding(7)
                .chatTimelineAccessoryInsetSurface()
            }
            if excerpt.truncated, let last = excerpt.lines.last?.n {
                Text(excerpt.totalLines.map { String(localized: "Stopped at line \(last) of \($0)") } ?? String(localized: "Stopped at line \(last)"))
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
            if let width = excerpt.wrappedAt {
                Text("Long lines wrapped at \(width) characters")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: HighlightRequest(excerpt: excerpt, isDark: colorScheme == .dark)) {
            let lines = await SourceFileHighlighter.shared.lines(
                in: excerpt.lines.map(\.text).joined(separator: "\n"),
                language: SourceFileLanguage.resolve(path: "", serverLanguage: excerpt.language),
                isDark: colorScheme == .dark
            )
            guard !Task.isCancelled else { return }
            coloured = lines.count == excerpt.lines.count ? lines : []
        }
    }

    private var gutterWidth: CGFloat {
        CGFloat(String(excerpt.lines.last?.n ?? 0).count) * 7
    }

    private func text(_ index: Int, _ line: FileExcerptLine) -> Text {
        guard index < coloured.count else { return Text(verbatim: line.text) }
        return coloured[index].segments.reduce(Text(verbatim: "")) { $0 + Text($1) }
    }
}

/// TAL-2323: a search's matches under each file's path, `line text` rows that open the file at that line.
struct SearchMatchesSection: View {
    let matches: SearchMatches
    @Environment(\.chatOpenWorkspaceFile) private var openFile

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if matches.files.isEmpty {
                Text("No matches")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(matches.files.enumerated()), id: \.offset) { _, file in
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        ToolFilePath(path: file.path, focusPath: file.focusPath, line: file.matches.first?.line)
                        if let count = file.count {
                            Text("Matches: \(count)")
                                .font(AppFont.caption())
                                .foregroundStyle(.secondary)
                                .fixedSize()
                        }
                    }
                    ForEach(Array(file.matches.enumerated()), id: \.offset) { _, match in
                        matchRow(file, match)
                    }
                }
            }
            if matches.truncated {
                Text("More results not shown")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatTimelineAccessoryInsetSurface()
    }

    @ViewBuilder
    private func matchRow(_ file: SearchMatchFile, _ match: SearchMatch) -> some View {
        let row = HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: String(match.line))
                .foregroundStyle(.secondary)
                .frame(minWidth: 28, alignment: .trailing)
            Text(verbatim: match.text)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(AppFont.mono(style: .caption))
        .frame(minHeight: 24)
        .contentShape(Rectangle())
        let openLabel = String(localized: "Open \(file.path) at line \(match.line)")
        Group {
            if let focusPath = file.focusPath, let openFile {
                Button {
                    openFile(WorkspaceFileLink(path: focusPath, line: match.line))
                } label: {
                    row
                }
                .buttonStyle(.plain)
                .accessibilityLabel(openLabel)
            } else {
                row.textSelection(.enabled)
            }
        }
        .contextMenu {
            if let focusPath = file.focusPath, let openFile {
                Button(openLabel) { openFile(WorkspaceFileLink(path: focusPath, line: match.line)) }
            }
            Button(String(localized: "Copy")) { PlatformHooks.copyText(match.text) }
        }
    }
}
