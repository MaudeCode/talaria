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

                        RotatingActivityTitle(
                            fallback: String(localized: "Thinking"),
                            titles: normalizedTitles,
                            isActive: isActive
                        )
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
                .accessibilityLabel(String(localized: "Thinking, \(normalizedTitles.last ?? String(localized: "Thinking"))"))
                .accessibilityHint(isExpanded ? "Double tap to collapse details." : "Double tap to expand details.")

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

}

enum ReasoningTitleRotation {
    static func shouldRotate(isActive: Bool, reduceMotion: Bool, titleCount: Int) -> Bool {
        isActive && !reduceMotion && titleCount > 1
    }

    static func displayedTitle(titles: [String], index: Int, isActive: Bool) -> String? {
        guard !titles.isEmpty else { return nil }
        guard isActive else { return titles.last }
        return titles[min(max(0, index), titles.count - 1)]
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

struct RotatingActivityTitle: View {
    let fallback: String
    let titles: [String]
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var titleIndex = 0

    var body: some View {
        ActivityGlowText(
            text: ReasoningTitleRotation.displayedTitle(
                titles: titles,
                index: titleIndex,
                isActive: isActive
            ) ?? fallback,
            isActive: isActive
        )
        .task(id: rotationTaskID) {
            titleIndex = 0
            guard ReasoningTitleRotation.shouldRotate(
                isActive: isActive,
                reduceMotion: reduceMotion,
                titleCount: titles.count
            ) else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(1.5))
                } catch {
                    return
                }
                titleIndex = (titleIndex + 1) % titles.count
            }
        }
    }

    private var rotationTaskID: String {
        "\(isActive)|\(reduceMotion)|\(titles.joined(separator: "\u{1F}"))"
    }
}
