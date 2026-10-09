import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct ChatCodeBlock: View {
    let language: String?
    let content: String
    let isStreaming: Bool

    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(ChatTranscriptDisplaySettings.wrapsCodeBlockLinesKey) private var wrapsCodeBlockLines = false
    @State private var copyConfirmation = CopyConfirmation()
    @State private var highlightedCode: NSAttributedString?

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
            }
        }
        .background(codeBlockBackground)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(SwiftUI.Color(.separator).opacity(0.35), lineWidth: 1)
        }
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
            PlainCodeBlockText(content: content, wraps: wrapsCodeBlockLines)
        }
    }

    /// The code body with its shared monospaced styling and padding. `fixedHorizontal`
    /// is `true` inside the horizontal `ScrollView` (each line keeps its natural width)
    /// and `false` when wrapping (lines reflow to the bubble width, growing vertically).
    private func styledCodeText(fixedHorizontal: Bool) -> some View {
        codeText
            .fixedSize(horizontal: fixedHorizontal, vertical: true)
            .relativeLineSpacing(.em(0.18))
            .markdownTextStyle {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.84))
            }
            .padding(.horizontal, 16)
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
