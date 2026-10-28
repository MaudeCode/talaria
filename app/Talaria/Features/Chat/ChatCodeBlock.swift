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
}

struct ChatCodeBlock: View {
    let language: String?
    let content: String
    let isStreaming: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.chatCodeBlockMargin) private var margin
    @AppStorage(ChatTranscriptDisplaySettings.wrapsCodeBlockLinesKey) private var wrapsCodeBlockLines = false
    @State private var copyConfirmation = CopyConfirmation()
    @State private var highlightedCode: NSAttributedString?
    @State private var scrollViewportWidth: CGFloat = 0
    @State private var columnWidth: CGFloat = 0
    @State private var naturalCodeWidth: CGFloat = 0

    private static let codeHorizontalPadding: CGFloat = 16

    private let logger = Logger.talariaMarkdownRendering

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(displayLanguage)
                    .font(.subheadline.weight(.semibold))

                Spacer()

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

                Button {
                    UIPasteboard.general.string = content
                    copyConfirmation.copied(at: .now)
                } label: {
                    Image(systemName: copyConfirmation.isShowing ? "checkmark" : "square.on.square")
                        .font(.system(size: 18, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .foregroundStyle(SwiftUI.Color.primary)
                .accessibilityLabel(copyConfirmation.isShowing ? "Copied code" : "Copy code")
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
        .onChange(of: content) { _, _ in
            copyConfirmation.reset()
        }
        .task(id: copyConfirmation.expiresAt) {
            guard let expiresAt = copyConfirmation.expiresAt else { return }
            try? await Task.sleep(until: expiresAt, clock: .continuous)
            guard !Task.isCancelled else { return }
            copyConfirmation.expire(at: .now)
        }
        .task(id: highlightRequest) {
            await updateHighlightedCode(for: highlightRequest)
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
        if let highlightedCode {
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

    @MainActor
    private func updateHighlightedCode(for request: MarkdownCodeHighlightRequest) async {
        highlightedCode = nil
        await Task.yield()

        guard !Task.isCancelled else { return }

        let result = MarkdownCodeHighlighter.highlightedCode(for: request)
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

        logger.info(
            "Syntax highlighting fallback reason=\(reason.rawValue, privacy: .public) languageCategory=\(MarkdownHighlightPolicy.languageLogCategory(for: normalizedLanguage), privacy: .public) characters=\(code.count, privacy: .public) lines=\(MarkdownHighlightPolicy.lineCount(in: code), privacy: .public)"
        )
    }
}
