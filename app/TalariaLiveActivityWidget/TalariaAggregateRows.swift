import SwiftUI
import TalariaKit

extension TalariaAggregateActivityAttributes.ContentState.Row {
    var sessionURL: URL? {
        TalariaDeepLink.sessionURL(sessionID: sessionId, publisherID: publisherId)
    }
}

/// The aggregate's session rows, up to `limit`. The first two waiting rows carry their buttons (TAL-1463).
struct TalariaAggregateRows: View {
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool
    let limit: Int
    let spacing: CGFloat

    var body: some View {
        let rows = LiveActivityRowActions.aggregateRows(state.rows, limit: limit)
        VStack(alignment: .leading, spacing: spacing) {
            if let answerError = state.answerError {
                LiveActivityAnswerError(text: answerError)
            }
            ForEach(rows, id: \.row.id) { item in
                AggregateRowLink(row: item.row, isStale: isStale, actions: item.actions)
            }
        }
    }
}

/// One aggregate row that opens its own session. The card's `widgetURL` only covers taps
/// outside a row and the compact and minimal presentations, which show no rows.
private struct AggregateRowLink: View {
    @Environment(\.liveActivityPalette) private var palette
    let row: TalariaAggregateActivityAttributes.ContentState.Row
    let isStale: Bool
    let actions: LiveActivityRowActions?

    var body: some View {
        let content = HStack(spacing: 7) {
            Text(row.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.primaryText)
                .lineLimit(1)
            Spacer(minLength: 8)
            if actions == nil, let counts = row.workCounts {
                AgentRunWorkCountsLabel(counts: counts, font: .system(size: 12, weight: .medium))
            }
            if actions == nil {
                AggregateStatusLabel(
                    status: row.status,
                    phase: row.phase,
                    isStale: isStale
                )
                .layoutPriority(1)
            }
        }
        HStack(spacing: 7) {
            if let url = row.sessionURL {
                Link(destination: url) { content }
            } else {
                content
            }
            if let actions {
                LiveActivityActionButtons(actions: actions)
                    .controlSize(.small)
                    .layoutPriority(1)
            }
        }
    }
}

extension LiveActivityPalette {
    func headerColor(for state: TalariaAggregateActivityAttributes.ContentState) -> Color {
        let hero = state.rows.first(where: {
            $0.phase == "waiting_for_approval" || $0.phase == "waiting_for_input"
        }) ?? state.rows.first(where: { $0.phase == "failed" }) ?? state.rows.first
        return hero.map { color(forPhase: $0.phase) } ?? primaryText
    }
}

/// TAL-2037: the aggregate's small family on the Apple Watch Smart Stack and CarPlay: the header line, then the first
/// session's row without its buttons.
struct TalariaAggregateSmallView: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(TalariaAggregateLiveActivityPresentation.headerText(state: state, isStale: isStale))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(isStale ? palette.secondaryText : palette.headerColor(for: state))
                .lineLimit(1)
            if let row = state.rows.first {
                AggregateRowLink(row: row, isStale: isStale, actions: nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}
