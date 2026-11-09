import Charts
import SwiftUI
import TalariaKit
import UIKit
import WebKit

/// TAL-1968: a file, table, chart or HTML page an agent showed, under its transcript row, rendered from the server's
/// block: an image inline or a file row whose Open shows the file, a table with the server's truncation note and Copy
/// (TSV), the chart with the server's formatted values and a values list, or the sandboxed page. It collects no input.
struct ShowBlockResultSection: View {
    let reference: ShowBlockRef
    @Environment(\.chatShowBlockModel) private var makeModel
    @Environment(\.chatOpenWorkspaceFile) private var openFile
    @Environment(\.openURL) private var openURL
    @State private var model: ShowBlockCardModel?

    var body: some View {
        let block = model?.block
        VStack(alignment: .leading, spacing: 6) {
            // On the title: an identifier on the section would replace its buttons' own.
            Text(block?.title ?? reference.title)
                .font(AppFont.callout(weight: .semibold))
                .accessibilityIdentifier("show-block-\(reference.blockId)")
            if let block, let model {
                content(block, model)
                let actions = actions(block, model)
                if !actions.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(actions, id: \.label) { action in
                            Button(action.label, action: action.run)
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("show-block-\(action.id)-\(reference.blockId)")
                        }
                    }
                    .frame(minHeight: 44)
                }
            } else if model?.failed == true {
                Text(String(localized: "This block is no longer available"))
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
        .contextMenu {
            if let block, let model {
                ForEach(actions(block, model), id: \.label) { action in
                    Button(action.label, action: action.run)
                }
            }
        }
        .padding(.leading, 24)
        .task(id: reference.blockId) {
            if model == nil { model = makeModel?(reference.blockId) }
            await model?.load()
        }
    }

    private struct Action {
        let id: String
        let label: String
        let run: () -> Void
    }

    /// The block's Open and Copy, for its buttons and its context menu alike.
    private func actions(_ block: ShowBlock, _ model: ShowBlockCardModel) -> [Action] {
        switch block.kind {
        case .file:
            guard let path = block.file?.path, let openFile else { return [] }
            return [Action(id: "open", label: String(localized: "Open")) { openFile(path) }]
        case .table:
            return [Action(id: "copy", label: String(localized: "Copy table")) { UIPasteboard.general.string = block.tsv }]
        case .chart:
            return []
        case .html:
            guard let url = model.frameURL else { return [] }
            return [Action(id: "open", label: String(localized: "Open")) { openURL(url) }]
        }
    }

    @ViewBuilder
    private func content(_ block: ShowBlock, _ model: ShowBlockCardModel) -> some View {
        switch block.kind {
        case .file:
            if let data = model.imageData, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240, alignment: .leading)
                    .accessibilityLabel(Text(block.title))
            } else if let file = block.file {
                Text(file.path)
                    .font(AppFont.caption().monospaced())
                    .foregroundStyle(.secondary)
            }
        case .table:
            ShowTableView(block: block)
        case .chart:
            ForEach(Array(block.series.enumerated()), id: \.offset) { _, series in
                ShowChartView(title: block.series.count > 1 ? "\(block.title) · \(series.name)" : nil, series: series, line: block.chart == "line")
            }
        case .html:
            if let url = model.frameURL {
                ShowFrameView(url: url)
                    .frame(height: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .accessibilityLabel(Text(block.title))
            }
        }
    }
}

/// The server's table: header and rows in fixed-width columns, scrolling both ways, and its truncation note.
private struct ShowTableView: View {
    let block: ShowBlock
    private static let columnWidth: CGFloat = 120

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(Array(block.rows.enumerated()), id: \.offset) { _, row in
                            line(row, header: false)
                            Divider()
                        }
                    } header: {
                        line(block.columns, header: true)
                            .background(Color(.systemBackground))
                    }
                }
            }
            .frame(maxHeight: 320)
            .fixedSize(horizontal: false, vertical: true)
            if let truncation = block.truncation {
                Text(String(localized: "Showing \(block.rows.count) of \(truncation.totalRows) rows and \(block.columns.count) of \(truncation.totalColumns) columns"))
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func line(_ cells: [String], header: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(cell)
                    .font(header ? AppFont.caption().weight(.semibold) : AppFont.caption())
                    .monospacedDigit()
                    .frame(width: Self.columnWidth, alignment: .leading)
                    .padding(.vertical, 4)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One series through the Insights chart kit (Swift Charts, the Insights grid style): bars or a line over the server's
/// labels, its largest value as the server formatted it, and every value in a list for VoiceOver and exact reading.
private struct ShowChartView: View {
    let title: String?
    let series: ShowBlock.Series
    let line: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if let title {
                    Text(title).font(AppFont.caption(weight: .semibold))
                }
                Spacer()
                Text(String(localized: "Max \(series.maxDisplay)"))
                    .font(AppFont.caption())
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Chart(Array(series.points.enumerated()), id: \.offset) { _, point in
                if line {
                    LineMark(x: .value("Label", point.label), y: .value(series.name, point.value))
                        .foregroundStyle(Color.accentColor)
                } else {
                    BarMark(x: .value("Label", point.label), y: .value(series.name, point.value))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 2))
                }
            }
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { _ in
                    AxisGridLine(stroke: InsightsChartAxis.gridStroke)
                }
            }
            .frame(height: 150)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(title ?? series.name))
            .accessibilityValue(Text(peakSummary))
            DisclosureGroup(String(localized: "Values")) {
                ForEach(Array(series.points.enumerated()), id: \.offset) { _, point in
                    LabeledContent(point.label) {
                        Text(point.display).font(.caption.monospacedDigit())
                    }
                    .font(.caption)
                }
            }
            .font(.caption)
        }
    }

    private var peakSummary: String {
        guard let peak = series.peak else { return series.name }
        return String(localized: "peak \(peak.display) at \(peak.label)")
    }
}

/// The block's page in a web view with no stored data. The server's response sandboxes it (`sandbox allow-scripts`,
/// no network source); the view loads only that one URL and opens nothing else.
private struct ShowFrameView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        init(url: URL) { self.url = url }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url == url ? .allow : .cancel
        }
    }
}

/// TAL-1968: the card model for a block id; the chat screen supplies it with its session's client.
typealias ChatShowBlockModel = ChatEnvironmentAction<String, ShowBlockCardModel>
/// TAL-1968: shows a workspace file on the companion page beside the chat, else in the file preview.
typealias ChatOpenWorkspaceFile = ChatEnvironmentAction<String, Void>

private struct ChatShowBlockModelKey: EnvironmentKey {
    static var defaultValue: ChatShowBlockModel? { nil }
}

private struct ChatOpenWorkspaceFileKey: EnvironmentKey {
    static var defaultValue: ChatOpenWorkspaceFile? { nil }
}

extension EnvironmentValues {
    var chatShowBlockModel: ChatShowBlockModel? {
        get { self[ChatShowBlockModelKey.self] }
        set { self[ChatShowBlockModelKey.self] = newValue }
    }

    var chatOpenWorkspaceFile: ChatOpenWorkspaceFile? {
        get { self[ChatOpenWorkspaceFileKey.self] }
        set { self[ChatOpenWorkspaceFileKey.self] = newValue }
    }
}
