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
        var remainingActions = LiveActivityRowActions.aggregateRowLimit
        let rows = state.rows.prefix(limit).map { row in
            let actions = remainingActions > 0 ? LiveActivityRowActions(row: row) : nil
            if actions != nil { remainingActions -= 1 }
            return (row: row, actions: actions)
        }
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
    let row: TalariaAggregateActivityAttributes.ContentState.Row
    let isStale: Bool
    let actions: LiveActivityRowActions?

    var body: some View {
        let content = HStack(spacing: 7) {
            Text(row.title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
            Spacer(minLength: 8)
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

enum AggregatePhaseStyle {
    static func color(
        for phase: String,
        isLuminanceReduced: Bool
    ) -> Color {
        guard let hex = TalariaAggregateLiveActivityPresentation.colorHex(
            for: phase,
            isLuminanceReduced: isLuminanceReduced
        ) else {
            return AgentRunLiveActivityTheme.secondaryText
        }
        return Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    static func headerColor(
        for state: TalariaAggregateActivityAttributes.ContentState,
        isLuminanceReduced: Bool
    ) -> Color {
        let hero = state.rows.first(where: {
            $0.phase == "waiting_for_approval" || $0.phase == "waiting_for_input"
        }) ?? state.rows.first(where: { $0.phase == "failed" }) ?? state.rows.first
        return hero.map {
            color(
                for: $0.phase,
                isLuminanceReduced: isLuminanceReduced
            )
        } ?? AgentRunLiveActivityTheme.primaryText
    }

    static func symbol(for phase: String) -> String {
        TalariaAggregateLiveActivityPresentation.signalSymbol(for: phase)
    }
}
