import SwiftUI
import TalariaKit

/// TAL-2324: a link's title beside the host it opens; a tap opens the page where the transcript's links open (the
/// in-app browser). The server sends only http(s) URLs, and none for a page it could not name one for.
private struct ToolResultLinkTitle: View {
    let title: String
    let url: String
    let domain: String
    @Environment(\.openURL) private var openURL

    var body: some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: title)
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(destination == nil ? Color.primary : Color.accentColor)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !domain.isEmpty {
                Text(verbatim: domain)
                    .font(AppFont.caption2())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .frame(minHeight: 28)
        .contentShape(Rectangle())
        if let destination {
            Button { openURL(destination) } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Open \(title)"))
                .contextMenu {
                    Button(String(localized: "Open \(title)")) { openURL(destination) }
                    Button(String(localized: "Copy link")) { PlatformHooks.copyText(url) }
                }
        } else {
            label
        }
    }

    private var destination: URL? {
        url.isEmpty ? nil : URL(string: url)
    }
}

/// TAL-2324: a search's links as title, domain and a one-line snippet; an X search's answer, formatted, above the links it
/// cited.
struct ResultLinksSection: View {
    let links: ResultLinks

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let answer = links.answer {
                MarkdownRenderer(content: answer)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if links.answer == nil, links.items.isEmpty {
                Text("No results")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(links.items.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 0) {
                    ToolResultLinkTitle(title: item.title, url: item.url, domain: item.domain)
                    if let snippet = item.snippet {
                        Text(verbatim: snippet)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatTimelineAccessoryInsetSurface()
    }
}

/// TAL-2324: each extracted page's title and domain over the start of its text; a page that failed as its error on one line.
struct ResultPagesSection: View {
    let pages: [ResultPage]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(pages.enumerated()), id: \.offset) { _, page in
                VStack(alignment: .leading, spacing: 2) {
                    ToolResultLinkTitle(title: page.title, url: page.url, domain: page.domain)
                    if let error = page.error {
                        Text(verbatim: error)
                            .font(AppFont.caption())
                            .foregroundStyle(.red)
                            .lineLimit(1)
                    } else if !page.excerpt.isEmpty {
                        MarkdownRenderer(content: page.excerpt)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatTimelineAccessoryInsetSurface()
    }
}
