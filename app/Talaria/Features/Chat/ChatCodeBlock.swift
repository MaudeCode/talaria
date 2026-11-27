import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

extension EnvironmentValues {
    /// The room on each side of the transcript's reading column that a wide code block may grow into (TAL-1487).
    @Entry var chatCodeBlockMargin: CGFloat = 0
    @Entry var chatAllowsCodePreview = true
    @Entry var chatOpenCodeBlockPreview: ChatEnvironmentAction<TranscriptDiagramPreview, Void>?
}

struct ChatCodeBlock: View {
    let language: String?
    let content: String
    let isStreaming: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.chatCodeBlockMargin) private var margin
    @Environment(\.chatAllowsCodePreview) private var allowsCodePreview
    @Environment(\.transcriptMediaParagraphImages) private var projectedMedia
    @Environment(\.chatOpenCodeBlockPreview) private var openPreview
    @Environment(\.chatFindMatch) private var findMatch
    @Environment(\.chatFindBlockID) private var selectedFindBlockID
    @AppStorage(ChatTranscriptDisplaySettings.wrapsCodeBlockLinesKey) private var wrapsCodeBlockLines = false
    @State private var highlightedCode: NSAttributedString?
    @State private var scrollViewportWidth: CGFloat = 0
    @State private var columnWidth: CGFloat = 0
    @State private var naturalCodeWidth: CGFloat = 0
    @State private var findBlockID = UUID()

    private static let codeHorizontalPadding: CGFloat = 16

    private let logger = Logger.talariaMarkdownRendering

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(displayLanguage)
                    .font(.subheadline.weight(.semibold))

                Spacer()

                if let preview, let openPreview {
                    Button {
                        openPreview(preview)
                    } label: {
                        Label(preview.kind.action, systemImage: "eye")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 18, weight: .semibold))
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(SwiftUI.Color.primary)
                    .help(preview.kind.action)
                }

                Button {
                    wrapsCodeBlockLines.toggle()
                } label: {
                    Image(systemName: wrapsCodeBlockLines ? "arrow.turn.down.left" : "arrow.left.and.right")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 36, height: 36)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .foregroundStyle(SwiftUI.Color.primary)
                .accessibilityLabel(wrapsCodeBlockLines ? "Disable code line wrapping" : "Enable code line wrapping")

                ChatCopyButton(
                    content,
                    label: String(localized: "Copy code"),
                    copiedLabel: String(localized: "Copied code"),
                    systemImage: "square.on.square",
                    side: 36
                )
                .font(.system(size: 18, weight: .semibold))
                .buttonStyle(.plain)
                .foregroundStyle(SwiftUI.Color.primary)
            }
            .padding(.leading, 16)
            .padding(.trailing, 10)
            .padding(.top, 14)
            .padding(.bottom, 4)

            if wrapsCodeBlockLines {
                styledCodeText(fixedHorizontal: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView(.horizontal) {
                    styledCodeText(fixedHorizontal: true)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { scrollViewportWidth = $0 }
            }
        }
        .background(codeBlockBackground)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(SwiftUI.Color(.separator).opacity(0.35), lineWidth: 1)
        }
        .padding(.horizontal, -bleed)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
        .task(id: highlightTaskKey) {
            await updateHighlightedCode()
        }
        // Code (and diff) blocks must never mirror inside an RTL message (#259):
        // the language header, copy/wrap controls, and the source itself stay LTR.
        .forcedLeftToRight()
    }

    /// How far the block grows past each side of its column: up to its lines' natural width, centred, within the
    /// transcript's margins. Above that it scrolls; wrapped lines never need it.
    private var bleed: CGFloat {
        guard !wrapsCodeBlockLines, columnWidth > 0 else { return 0 }
        let excess = naturalCodeWidth.rounded(.up) + 2 * Self.codeHorizontalPadding - columnWidth
        return min(margin, max(0, excess / 2))
    }

    private var codeBlockBackground: SwiftUI.Color {
        colorScheme == .dark
            ? SwiftUI.Color(red: 0.04, green: 0.05, blue: 0.07)
            : SwiftUI.Color(.secondarySystemBackground)
    }

    @ViewBuilder
    private var codeText: some View {
        // A settled block highlighted before draws from the cache at once instead of flashing plain text (TAL-854).
        let highlightedCode = MarkdownCodeHighlighter.cachedHighlightedCode(for: highlightRequest) ?? highlightedCode
        if let findMatch, findBlockID == selectedFindBlockID,
           let range = findMatch.range.nsRange(in: content) {
            let original = highlightedCode.flatMap { $0.string == content ? $0 : nil } ?? NSAttributedString(string: content)
            let styled = NSMutableAttributedString(attributedString: original)
            let _ = styled.addAttribute(.backgroundColor, value: ChatFindBlocks.highlight, range: range)
            HighlightedCodeBlockText(content: styled, wraps: wrapsCodeBlockLines)
        } else if let highlightedCode {
            HighlightedCodeBlockText(content: highlightedCode, wraps: wrapsCodeBlockLines)
        } else {
            PlainCodeBlockText(
                content: content,
                wraps: wrapsCodeBlockLines,
                colorsDiffLines: MarkdownDiffLineKind.applies(to: language)
            )
        }
    }

    /// The code body with its shared monospaced styling and padding. `fixedHorizontal`
    /// is `true` inside the horizontal `ScrollView` (each line keeps its natural width)
    /// and `false` when wrapping (lines reflow to the bubble width, growing vertically).
    /// When scrolling, the body is at least as wide as the block, so a diff
    /// line's tint reaches the block's edge even when every line is short.
    private func styledCodeText(fixedHorizontal: Bool) -> some View {
        codeText
            .preference(key: ChatFindBlocks.self, value: ChatFindBlocks.includes(findMatch?.block, text: content, isCode: true) ? [findBlockID] : [])
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { naturalCodeWidth = $0 }
            .frame(minWidth: fixedHorizontal ? max(scrollViewportWidth - 2 * Self.codeHorizontalPadding, 0) : nil, alignment: .leading)
            .fixedSize(horizontal: fixedHorizontal, vertical: true)
            .relativeLineSpacing(.em(0.18))
            .markdownTextStyle {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.84))
            }
            .padding(.horizontal, Self.codeHorizontalPadding)
            .padding(.top, 8)
            .padding(.bottom, 16)
    }

    private var highlightRequest: MarkdownCodeHighlightRequest {
        MarkdownCodeHighlightRequest(
            code: content,
            language: language,
            colorScheme: colorScheme,
            isStreaming: isStreaming
        )
    }

    /// Fixed while the block streams, so no update restarts the highlight task; a settled block keys on its code's
    /// hash, so the task runs once when the stream ends and again only if the code changes (TAL-1396).
    private var highlightTaskKey: HighlightTaskKey {
        HighlightTaskKey(
            isStreaming: isStreaming,
            contentHash: isStreaming ? nil : content.hashValue,
            language: language,
            colorScheme: colorScheme
        )
    }

    private struct HighlightTaskKey: Equatable {
        let isStreaming: Bool
        let contentHash: Int?
        let language: String?
        let colorScheme: ColorScheme
    }

    @MainActor
    private func updateHighlightedCode() async {
        highlightedCode = nil
        // Streaming code is always drawn plain, so there is nothing to decide or log until the stream ends.
        guard !isStreaming else { return }
        let request = highlightRequest
        let result = await MarkdownCodeHighlighter.highlightedCode(for: request)
        guard !Task.isCancelled else { return }

        switch result {
        case .highlighted(let attributedString):
            highlightedCode = attributedString
        case .plain(let reason, let normalizedLanguage):
            highlightedCode = nil
            logFallback(
                reason: reason,
                normalizedLanguage: normalizedLanguage,
                code: request.code
            )
        }
    }

    private var displayLanguage: String {
        guard let name = normalizedLanguage else {
            return String(localized: "Code")
        }

        switch name {
        case "js":
            return "JavaScript"
        case "ts":
            return "TypeScript"
        case "py":
            return "Python"
        default:
            return name.uppercased() == name ? name : name.capitalized
        }
    }

    private var normalizedLanguage: String? {
        guard let normalized = language?
            .split(whereSeparator: { $0.isWhitespace })
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
            !normalized.isEmpty
        else { return nil }
        return normalized
    }

    private var preview: TranscriptDiagramPreview? {
        guard allowsCodePreview, !isStreaming, let normalizedLanguage else { return nil }
        return projectedMedia?.display.diagramPreviews?.first {
            $0.kind.rawValue == normalizedLanguage && $0.source == content
        }
    }

    /// The Copy button's checkmark state, keyed to the latest copy's expiry.
    struct CopyConfirmation {
        static let displayDuration: Duration = .seconds(2)

        private(set) var expiresAt: ContinuousClock.Instant?

        var isShowing: Bool { expiresAt != nil }

        /// Every copy restarts the full interval.
        mutating func copied(at now: ContinuousClock.Instant) {
            expiresAt = now + Self.displayDuration
        }

        /// Clears the checkmark only once the latest copy's interval has passed,
        /// so a reset scheduled by an earlier copy cannot clear newer feedback.
        mutating func expire(at now: ContinuousClock.Instant) {
            if let expiresAt, now >= expiresAt {
                self.expiresAt = nil
            }
        }

        mutating func reset() {
            expiresAt = nil
        }
    }

    private func logFallback(reason: MarkdownHighlightFallbackReason, normalizedLanguage: String?, code: String) {
        guard reason != .empty else { return }
#if DEBUG
        ChatBodyEvaluationRecorder.record("highlightFallback")
#endif

        logger.info(
            "Syntax highlighting fallback reason=\(reason.rawValue, privacy: .public) languageCategory=\(MarkdownHighlightPolicy.languageLogCategory(for: normalizedLanguage), privacy: .public) characters=\(code.count, privacy: .public) lines=\(MarkdownHighlightPolicy.lineCount(in: code), privacy: .public)"
        )
    }
}

private extension TranscriptDiagramPreview.Kind {
    var action: LocalizedStringKey {
        self == .svg ? "View image" : "View diagram"
    }

    var title: Text {
        self == .svg ? Text(verbatim: "SVG") : Text("Diagram")
    }
}

struct CodeBlockPreviewView: View {
    let preview: TranscriptDiagramPreview
    let client: APIClient

    @State private var imageURL: URL?
    @State private var frameIsLoading = true
    @State private var failure: String?

    var body: some View {
        Group {
            if let failure {
                ContentUnavailableView {
                    Label("Could Not Load Media", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                }
            } else if let imageURL {
                ShowFrameView(url: imageURL, onLoad: { frameIsLoading = false }, onFailure: { imageFailed() })
                    .accessibilityLabel(preview.kind.title)
                    .background(.white, ignoresSafeAreaEdges: [])
                    .overlay {
                        if frameIsLoading {
                            progress.environment(\.colorScheme, .light)
                        }
                    }
            } else {
                progress
            }
        }
        .navigationTitle(preview.kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .adaptiveNavigationBarBackground()
        .task(id: preview) { await loadPreview() }
    }

    private var progress: some View {
        ProgressView("Loading media...")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadPreview() async {
        imageURL = nil
        frameIsLoading = true
        failure = nil
        do {
            let result = try await client.renderDiagram(preview)
            guard !Task.isCancelled else { return }
            switch result {
            case .svg(let svg):
                imageURL = ShowFrameView.svgImageURL(svg)
                if imageURL == nil { imageFailed() }
            case .error(let error):
                failure = error
            }
        } catch {
            guard !Task.isCancelled, !APIError.isCancellation(error) else { return }
            failure = error.localizedDescription
        }
    }

    private func imageFailed() {
        failure = String(localized: "Could not preview this image.")
    }
}

/// The chat's one Copy button: code blocks, tool rows and replies (TAL-965). After each copy it shows a checkmark and
/// reads `copiedLabel` for two seconds; a change of `text` clears that. Callers set its font and button style.
struct ChatCopyButton: View {
    private let text: String
    private let label: String
    private let copiedLabel: String
    private let systemImage: String
    private let side: CGFloat
    private let copy: () -> Void

    @State private var confirmation = ChatCodeBlock.CopyConfirmation()

    /// `copy` defaults to putting `text` on the pasteboard.
    init(
        _ text: String,
        label: String = String(localized: "Copy"),
        copiedLabel: String = String(localized: "Copied"),
        systemImage: String = "doc.on.doc",
        side: CGFloat = 44,
        copy: (() -> Void)? = nil
    ) {
        self.text = text
        self.label = label
        self.copiedLabel = copiedLabel
        self.systemImage = systemImage
        self.side = side
        self.copy = copy ?? { PlatformHooks.copyText(text) }
    }

    var body: some View {
        Button {
            copy()
            confirmation.copied(at: .now)
        } label: {
            Image(systemName: confirmation.isShowing ? "checkmark" : systemImage)
                .frame(width: side, height: side)
                .contentShape(Rectangle())
                .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityLabel(confirmation.isShowing ? copiedLabel : label)
        .help(label)
        .onChange(of: text) { _, _ in
            confirmation.reset()
        }
        .task(id: confirmation.expiresAt) {
            guard let expiresAt = confirmation.expiresAt else { return }
            try? await Task.sleep(until: expiresAt, clock: .continuous)
            guard !Task.isCancelled else { return }
            confirmation.expire(at: .now)
        }
    }
}
