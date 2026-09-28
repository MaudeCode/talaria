import SwiftUI
import TalariaKit

struct ReasoningBlockView: View {
    let text: String
    let titles: [String]
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @AppStorage(ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey) private var startsExpanded = false
    @State private var userToggledExpansion: Bool?

    init(text: String, titles: [String] = [], isActive: Bool = false) {
        self.text = text
        self.titles = titles
        self.isActive = isActive
    }

    private var isExpanded: Bool {
        ChatTranscriptDisplaySettings.isCardExpanded(
            userToggled: userToggledExpansion,
            startsExpanded: startsExpanded
        )
    }

    var body: some View {
        if let trimmedText {
            VStack(alignment: .leading, spacing: isExpanded ? 6 : 0) {
                Button {
                    chatDisclosureToggled()
                    withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                        userToggledExpansion = !isExpanded
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image("LucideBrain")
                            .resizable()
                            .scaledToFit()
                            .foregroundStyle(.secondary)
                            .frame(width: 16, height: 16)

                        RotatingActivityTitle(
                            fallback: String(localized: "Thinking"),
                            titles: normalizedTitles,
                            isActive: isActive
                        )
                            .font(AppFont.callout())
                            .lineLimit(1)
                            .truncationMode(.tail)

                        Spacer(minLength: 4)

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Thinking, \(normalizedTitles.last ?? String(localized: "Thinking"))"))
                .accessibilityHint(isExpanded ? "Double tap to collapse details." : "Double tap to expand details.")

                if isExpanded {
                    MarkdownRenderer(content: trimmedText)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 24)
                        .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var trimmedText: String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var normalizedTitles: [String] {
        ReasoningTitleMetadata.normalize(titles)
    }

}
