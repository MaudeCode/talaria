import Charts
import SwiftUI
import TalariaKit
import UIKit
import WebKit

/// TAL-1968: a file, table, chart or HTML page an agent showed, under its transcript row, rendered from the server's
/// block: an image inline or a file row whose Open shows the file, a table with the server's truncation note and Copy
/// (TSV), the chart with the server's formatted values and a values list, or the sandboxed page. It collects no input.
/// TAL-1971: a delivered file adds its name, size and type, the server's "changed since delivered" note, and Share and
/// Save to Files, which fetch it through the authenticated raw route.
struct ShowBlockResultSection: View {
    let reference: ShowBlockRef
    @Environment(\.chatShowBlockModel) private var makeModel
    @Environment(\.chatOpenWorkspaceFile) private var openFile
    @Environment(\.openURL) private var openURL
    @State private var model: ShowBlockCardModel?
    @State private var fetching = false
    @State private var shareItem: SessionExportShareItem?
    @State private var exportPayload: FileExportPayload?
    @State private var errorMessage: String?

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
                        // TAL-1971: a delivered file downloading for Share or Save to Files.
                        if fetching { ProgressView() }
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
        .sheet(item: $shareItem) { item in
            SessionExportShareSheet(fileURL: item.fileURL)
                .presentationDetents([.medium, .large])
                .ignoresSafeArea()
                // The file sits in its own temporary directory; it goes once the sheet does.
                .onDisappear { try? FileManager.default.removeItem(at: item.fileURL.deletingLastPathComponent()) }
        }
        .fileExporter(payload: $exportPayload, errorTitle: "Download Failed", errorMessage: $errorMessage)
    }

    /// Fetches the delivered file once at a time, then hands it to `use`; a failure shows in the download alert.
    private func fetchDelivered(_ model: ShowBlockCardModel, then use: @escaping (FileExportPayload) throws -> Void) {
        guard !fetching else { return }
        fetching = true
        Task {
            defer { fetching = false }
            do { try use(try await model.deliveredFile()) } catch { errorMessage = error.localizedDescription }
        }
    }

    private func share(_ payload: FileExportPayload) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(payload.filename)
        try payload.data.write(to: url)
        shareItem = SessionExportShareItem(fileURL: url)
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
            let save = block.delivery == nil ? [] : [
                Action(id: "share", label: String(localized: "Share")) { fetchDelivered(model, then: share) },
                Action(id: "save", label: String(localized: "Save to Files")) { fetchDelivered(model) { exportPayload = $0 } },
            ]
            guard let path = block.file?.path, let openFile else { return save }
            return save + [Action(id: "open", label: String(localized: "Open")) { openFile(WorkspaceFileLink(path: path)) }]
        case .table:
            return [Action(id: "copy", label: String(localized: "Copy table")) { PlatformHooks.copyText(block.tsv) }]
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
            if let delivery = block.delivery, let file = block.file {
                Text([file.name, ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file), delivery.mime].joined(separator: " · "))
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                if delivery.changed {
                    Text(String(localized: "Changed since delivered"))
                        .font(AppFont.caption())
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("show-block-changed-\(block.blockId)")
                }
            }
            if let data = model.imageData, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240, alignment: .leading)
                    .accessibilityLabel(Text(block.title))
            } else if block.delivery == nil, let file = block.file {
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

/// The inline frame keeps its measured space in the transcript while its web view is off-screen.
struct InlineReportView<Fallback: View>: View {
    let url: URL
    let title: String
    let expand: () -> Void
    @ViewBuilder let fallback: () -> Fallback
    @Environment(\.openURL) private var openURL
    @State private var visible = false
    @State private var failed = false
    @State private var contentHeight: CGFloat = 320
    @State private var viewportHeight: CGFloat = 0

    var body: some View {
        if failed {
            fallback()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(title)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(action: expand) {
                        Label("Expand report", systemImage: "arrow.up.left.and.arrow.down.right")
                            .labelStyle(.iconOnly)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Expand report")
                }
                Group {
                    if visible {
                        ShowFrameView(url: url, openLink: { openURL($0) }, onHeight: { contentHeight = $0 },
                                      onFailure: { failed = true })
                    } else {
                        Color.clear.accessibilityHidden(true)
                    }
                }
                .frame(height: min(max(120, contentHeight), viewportHeight > 0 ? 3 * viewportHeight : 320))
                .onScrollVisibilityChange(threshold: 0.001) { visible = $0 }
                .onGeometryChange(for: CGFloat.self) { $0.bounds(of: .scrollView)?.height ?? 0 } action: { viewportHeight = $0 }
            }
            .contextMenu {
                Button("Expand report", systemImage: "arrow.up.left.and.arrow.down.right", action: expand)
            }
        }
    }
}

/// A server-sandboxed show block or delivered report in a web view with no stored data.
struct ShowFrameView: UIViewRepresentable {
    let url: URL
    var openLink: ((URL) -> Void)? = nil
    var onHeight: ((CGFloat) -> Void)? = nil
    var onLoad: (() -> Void)? = nil
    var onFailure: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(HeaderLogoColor.storageKey) private var accentHex = HeaderLogoColor.defaultHex

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if openLink != nil {
            let controller = configuration.userContentController
            controller.add(context.coordinator, contentWorld: .defaultClient, name: "report")
            controller.addUserScript(WKUserScript(source: Self.reportScript(measureHeight: onHeight != nil),
                                                  injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.allowsLinkPreview = openLink == nil
        view.scrollView.isScrollEnabled = onHeight == nil
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.openLink = openLink
        coordinator.onHeight = onHeight
        coordinator.onLoad = onLoad
        coordinator.onFailure = onFailure
        let loadURL = openLink == nil ? url : themedURL
        guard coordinator.requestedURL != loadURL else { return }
        coordinator.requestedURL = loadURL
        coordinator.admitsInitialLoad = true
        var request = URLRequest(url: loadURL)
        request.httpShouldHandleCookies = false
        coordinator.navigation = view.load(request)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.navigationDelegate = nil
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "report", contentWorld: .defaultClient)
    }

    private var themedURL: URL {
        let traits = UITraitCollection(userInterfaceStyle: colorScheme == .dark ? .dark : .light)
        func css(_ color: UIColor) -> String {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let channels = [red, green, blue].map { Int((min(max(0, $0), 1) * 255).rounded()) }
            return String(format: "#%02x%02x%02x", channels[0], channels[1], channels[2])
        }
        let variables = [
            "--background": css(.systemBackground), "--foreground": css(.label),
            "--card": css(.secondarySystemBackground), "--muted": css(.tertiarySystemBackground),
            "--muted-foreground": css(.secondaryLabel), "--border": css(.separator),
            "--primary": HeaderLogoColor.normalizedHex(accentHex) ?? HeaderLogoColor.defaultHex,
            "--primary-foreground": HeaderLogoColor.prefersDarkForeground(for: accentHex) ? "#000000" : "#ffffff",
            "--font-sans": "system-ui", "--font-mono": "ui-monospace",
        ]
        // Sorted keys give repeated SwiftUI updates the same URL for an unchanged theme.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let theme = try? encoder.encode(variables)
        return url.appending(queryItems: [URLQueryItem(name: "theme", value: theme.map { String(decoding: $0, as: UTF8.self) })])
    }

    /// The separate content world keeps the bridge out of the report's script namespace.
    private static func reportScript(measureHeight: Bool) -> String {
        """
        const reportBridge = window.webkit.messageHandlers.report;
        window.addEventListener('click', event => {
          const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
          if (!anchor) return;
          event.preventDefault();
          if (!event.isTrusted) return;
          const href = anchor.getAttribute('href');
          if (href.startsWith('#')) { location.hash = href; return; }
          reportBridge.postMessage({ link: new URL(href, document.baseURI).href });
        }, true);
        if (\(measureHeight)) {
          window.addEventListener('DOMContentLoaded', () => {
            const body = document.body;
            if (!body) return;
            new ResizeObserver(() => {
              const height = Math.max(body.scrollHeight, body.getBoundingClientRect().bottom) + parseFloat(getComputedStyle(body).marginBottom);
              reportBridge.postMessage({ height, width: innerWidth });
            }).observe(body);
          });
        }
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var requestedURL: URL?
        var admitsInitialLoad = false
        var navigation: WKNavigation?
        var openLink: ((URL) -> Void)?
        var onHeight: ((CGFloat) -> Void)?
        var onLoad: (() -> Void)?
        var onFailure: (() -> Void)?

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard navigationAction.targetFrame?.isMainFrame == true,
                  let destination = navigationAction.request.url else { return .cancel }
            if admitsInitialLoad, destination == requestedURL, navigationAction.navigationType == .other {
                admitsInitialLoad = false
                return .allow
            }
            // A fragment can scroll this document without loading a different page.
            if openLink != nil, var parts = URLComponents(url: destination, resolvingAgainstBaseURL: false),
               parts.fragment != nil {
                parts.fragment = nil
                if parts.url == requestedURL { return .allow }
            }
            return .cancel
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            guard response.isForMainFrame, response.response.url == requestedURL else { return .cancel }
            guard openLink != nil else { return .allow }
            // An expired grant or a file that grew past the preview cap uses the download row.
            guard let http = response.response as? HTTPURLResponse, http.statusCode == 200,
                  http.mimeType == "text/html", http.value(forHTTPHeaderField: "Content-Security-Policy")?.hasPrefix("sandbox ") == true
            else {
                onFailure?()
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            guard navigation === self.navigation, (error as NSError).code != NSURLErrorCancelled else { return }
            onFailure?()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if navigation === self.navigation { onLoad?() }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
            if let link = body["link"] as? String, link.utf8.count <= 4096, let url = URL(string: link),
               ["http", "https", "file", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") || TalariaDeepLink.isAppURL(url) {
                openLink?(url)
            }
            if let height = body["height"] as? Double, let width = body["width"] as? Double,
               height.isFinite, height >= 0, width.isFinite, width > 0, let webView = message.webView {
                onHeight?(ceil(height * webView.bounds.width / width))
            }
        }
    }
}

/// TAL-1968: the card model for a block id; the chat screen supplies it with its session's client.
typealias ChatShowBlockModel = ChatEnvironmentAction<String, ShowBlockCardModel>
/// TAL-1968: shows a workspace file on the companion page beside the chat, else in the file preview.
typealias ChatOpenWorkspaceFile = ChatEnvironmentAction<WorkspaceFileLink, Void>

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
