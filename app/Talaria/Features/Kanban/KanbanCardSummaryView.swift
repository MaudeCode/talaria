import SwiftUI
import TalariaKit

struct KanbanCardSummaryView: View {
    let card: KanbanCard
    var reservesTrailingActionSpace = false
    @ScaledMetric(relativeTo: .caption) private var stalenessIconSlot = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let priority = card.priority {
                    Text(verbatim: "P\(priority)")
                        .font(.caption.monospaced().weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.secondary.opacity(0.12), in: Capsule())
                }
                Text(card.cardID ?? String(localized: "Unknown Card"))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if let age = card.ageSeconds {
                    HStack(spacing: 3) {
                        Image(systemName: stalenessImage)
                            .frame(width: stalenessIconSlot)
                        Text(KanbanAgeFormatter.abbreviated(age))
                            .monospaced()
                    }
                        .font(.caption)
                        .foregroundStyle(stalenessColor)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }

            Text(card.title ?? String(localized: "Untitled Card"))
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, trailingActionInset)

            if let body = card.body, !body.isEmpty {
                Text(markdownPreview(body))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .padding(.trailing, trailingActionInset)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    metadataLabels(locksHorizontalSize: true)
                }
                VStack(alignment: .leading, spacing: 5) {
                    metadataLabels(locksHorizontalSize: false)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.trailing, trailingActionInset)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(KanbanCardAccessibility.summary(card))
    }

    private var trailingActionInset: CGFloat {
        reservesTrailingActionSpace ? 44 : 0
    }

    @ViewBuilder
    private func metadataLabels(locksHorizontalSize: Bool) -> some View {
        metadataLabel(
            card.assignee ?? String(localized: "Unassigned"),
            systemImage: "person",
            locksHorizontalSize: locksHorizontalSize
        )
        if let tenant = card.tenant, !tenant.isEmpty {
            metadataLabel(
                tenant,
                systemImage: "building.2",
                locksHorizontalSize: locksHorizontalSize
            )
        }
        if let comments = card.commentCount, comments > 0 {
            metadataLabel(
                "\(comments)",
                systemImage: "bubble.left",
                locksHorizontalSize: locksHorizontalSize
            )
        }
        let dependencies = (card.linkCounts?.parents ?? 0) + (card.linkCounts?.children ?? 0)
        if dependencies > 0 {
            metadataLabel(
                "\(dependencies)",
                systemImage: "link",
                locksHorizontalSize: locksHorizontalSize
            )
        }
    }

    private func metadataLabel(
        _ title: String,
        systemImage: String,
        locksHorizontalSize: Bool
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Image(systemName: systemImage)
            Text(title)
        }
        .fixedSize(horizontal: locksHorizontalSize, vertical: false)
    }

    private var stalenessImage: String {
        switch card.staleness {
        case .none: "clock"
        case .warning: "clock.badge.exclamationmark"
        case .critical: "exclamationmark.triangle.fill"
        }
    }

    private var stalenessColor: Color {
        switch card.staleness {
        case .none: .secondary
        case .warning: .orange
        case .critical: .red
        }
    }

    private func markdownPreview(_ source: String) -> AttributedString {
        (try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(source)
    }
}
