import SwiftUI
import TalariaKit

/// TAL-2326: a memory, skill, past-chat, scheduled job, connection or clarify result as its title, its rows (a status dot,
/// the label, a muted detail line) and a viewed skill's formatted text. A row the server linked opens that Talaria page.
/// TAL-2027: rows shown under a folded row (`wraps`) wrap whole, so an answered question reads in full.
struct ToolRowsSection: View {
    let rows: ToolRows
    var wraps = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = rows.title {
                Text(verbatim: title)
                    .font(AppFont.caption2())
                    .foregroundStyle(.secondary)
                    .lineLimit(wraps ? nil : 1)
            }
            ForEach(Array(rows.rows.enumerated()), id: \.offset) { _, row in
                ToolRowView(row: row, wraps: wraps)
            }
            if let markdown = rows.markdown {
                MarkdownRenderer(content: markdown)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatTimelineAccessoryInsetSurface()
    }
}

private struct ToolRowView: View {
    let row: ToolRow
    let wraps: Bool
    @Environment(\.openURL) private var openURL

    var body: some View {
        let destination = row.link?.destinationURL
        let content = VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let color = dotColor {
                    Circle()
                        .fill(color)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                Text(verbatim: row.label)
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(destination == nil ? Color.primary : Color.accentColor)
                    .lineLimit(wraps ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let detail = row.detail {
                Text(verbatim: detail)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .lineLimit(wraps ? nil : 1)
            }
        }
        .frame(minHeight: 28)
        .contentShape(Rectangle())
        if let destination {
            Button { openURL(destination) } label: { content }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }

    private var dotColor: Color? {
        switch row.status {
        case "ok": .green
        case "warn": .orange
        case "error": .red
        case "pending": .accentColor
        default: nil
        }
    }
}
