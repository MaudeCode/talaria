import SwiftUI

struct ReasoningBlockView: View {
    let text: String
    let titles: [String]
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                TimelineView(.animation(
                    minimumInterval: 1.5,
                    paused: !isActive || normalizedTitles.count < 2
                )) { context in
                    let title = displayedTitle(at: context.date)
                    Button {
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

                            ActivityGlowText(text: title, isActive: isActive)
                                .font(AppFont.caption())
                                .lineLimit(2)

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
                    .accessibilityLabel(String(localized: "Thinking, \(title)"))
                    .accessibilityHint(isExpanded ? "Double tap to collapse details." : "Double tap to expand details.")
                }

                if isExpanded {
                    Text(trimmedText)
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

    private func displayedTitle(at date: Date) -> String {
        let values = normalizedTitles
        guard !values.isEmpty else { return String(localized: "Thinking") }
        guard isActive, values.count > 1 else { return values.last! }
        let index = Int(date.timeIntervalSinceReferenceDate / 1.5) % values.count
        return values[index]
    }
}

struct ActivityGlowText: View {
    let text: String
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if isActive, !reduceMotion {
            TimelineView(.animation) { context in
                let progress = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 2) / 2
                Text(text)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.secondary, .primary, .secondary],
                            startPoint: UnitPoint(x: progress * 2 - 1, y: 0.5),
                            endPoint: UnitPoint(x: progress * 2, y: 0.5)
                        )
                    )
            }
        } else {
            Text(text)
                .foregroundStyle(.secondary)
        }
    }
}
