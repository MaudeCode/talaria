import ActivityKit
import SwiftUI
import WidgetKit

@main
struct TalariaLiveActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentRunLiveActivityWidget()
        TalariaAggregateLiveActivityWidget()
        ProviderQuotaWidget()
        ProviderQuotaPaceWidget()
    }
}

struct TalariaAggregateLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TalariaAggregateActivityAttributes.self) { context in
            let isStale = TalariaAggregateLiveActivityPresentation.isEffectivelyStale(
                state: context.state,
                isStale: context.isStale
            )
            VStack(alignment: .leading, spacing: 6) {
                TalariaAggregateHeader(state: context.state, isStale: isStale)
                ForEach(context.state.rows.prefix(TalariaAggregateLiveActivityPresentation.lockScreenRowLimit)) { row in
                    HStack(spacing: 7) {
                        Text(row.title)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        AggregateStatusLabel(
                            status: row.status,
                            phase: row.phase,
                            isStale: isStale
                        )
                            .layoutPriority(1)
                    }
                }
            }
            .padding(14)
            .activityBackgroundTint(AgentRunLiveActivityTheme.background)
            .activitySystemActionForegroundColor(AgentRunLiveActivityTheme.primaryText)
            .widgetURL(context.state.rows.first.flatMap {
                TalariaDeepLink.sessionURL(sessionID: $0.sessionId, publisherID: $0.publisherId)
            })
        } dynamicIsland: { context in
            let isStale = TalariaAggregateLiveActivityPresentation.isEffectivelyStale(
                state: context.state,
                isStale: context.isStale
            )
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SandalMark(height: 15)
                    .padding(.leading, 4)
                    .padding(.vertical, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(isStale
                        ? String(localized: "Waiting")
                        : "\(context.state.activeCount) active")
                        .font(.caption)
                        .lineLimit(1)
                        .padding(.trailing, 8)
                        .padding(.vertical, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(context.state.rows.prefix(
                            TalariaAggregateLiveActivityPresentation.expandedIslandRowLimit
                        )) { row in
                            HStack(spacing: 7) {
                                Text(row.title)
                                    .font(.system(size: 13, weight: .semibold))
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                AggregateStatusLabel(
                                    status: row.status,
                                    phase: row.phase,
                                    isStale: isStale
                                )
                                    .layoutPriority(1)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                }
            } compactLeading: {
                SandalMark(height: 16)
            } compactTrailing: {
                AggregateCompactTrailing(state: context.state, isStale: isStale)
            } minimal: {
                SandalMark(height: 13)
            }
            .widgetURL(context.state.rows.first.flatMap {
                TalariaDeepLink.sessionURL(sessionID: $0.sessionId, publisherID: $0.publisherId)
            })
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


struct AgentRunLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentRunActivityAttributes.self) { context in
            AgentRunLockScreenView(context: context)
                .activityBackgroundTint(AgentRunLiveActivityTheme.background)
                .activitySystemActionForegroundColor(AgentRunLiveActivityTheme.primaryText)
                .widgetURL(TalariaDeepLink.sessionURL(sessionID: context.state.sessionID))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgentRunIslandBadge(status: context.state.status)
                        .padding(.leading, 18)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    AgentRunIslandStatusView(state: context.state)
                        .padding(.trailing, 18)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    AgentRunExpandedIslandBottomView(state: context.state)
                }
            } compactLeading: {
                AgentRunIslandCompactMark(status: context.state.status)
            } compactTrailing: {
                Text(context.state.status.compactTitle)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AgentRunStatusStyle.color(for: context.state.status, isStale: context.state.isStale))
                    .minimumScaleFactor(0.72)
                    .lineLimit(1)
            } minimal: {
                AgentRunIslandCompactMark(status: context.state.status)
            }
            .widgetURL(TalariaDeepLink.sessionURL(sessionID: context.state.sessionID))
            .keylineTint(AgentRunStatusStyle.color(for: context.state.status, isStale: context.state.isStale))
        }
    }
}










enum AgentRunLiveActivityTheme {
    static let background = Color(red: 0.025, green: 0.028, blue: 0.038)
    static let primaryText = Color.white
    static let secondaryText = Color.white.opacity(0.68)
    static let stroke = Color.white.opacity(0.13)
    static let pillBackground = Color.white.opacity(0.08)
    static let railBackground = Color.white.opacity(0.14)
    static let liveDot = Color(red: 0.35, green: 0.95, blue: 0.7)
}

enum AgentRunStatusStyle {
    static func color(for status: AgentRunActivityStatus, isStale: Bool) -> Color {
        if isStale {
            return Color.white.opacity(0.52)
        }

        switch status {
        case .starting, .thinking, .responding:
            return Color(red: 1.0, green: 0.82, blue: 0.18)
        case .usingTool:
            return Color(red: 0.50, green: 0.72, blue: 1.0)
        case .searchingFiles:
            return Color(red: 0.22, green: 0.92, blue: 0.95)
        case .readingFiles:
            return Color(red: 0.58, green: 0.78, blue: 1.0)
        case .runningCommand:
            return Color(red: 0.76, green: 0.55, blue: 1.0)
        case .waitingForApproval:
            return Color(red: 1.0, green: 0.58, blue: 0.24)
        case .waitingForClarification:
            return Color(red: 1.0, green: 0.65, blue: 0.30)
        case .complete:
            return Color(red: 0.35, green: 0.95, blue: 0.55)
        case .failed:
            return Color(red: 1.0, green: 0.32, blue: 0.32)
        case .cancelled:
            return Color.white.opacity(0.56)
        }
    }

    static func symbolName(for status: AgentRunActivityStatus) -> String {
        switch status {
        case .starting:
            "sparkle"
        case .thinking:
            "brain.head.profile"
        case .usingTool:
            "wrench.and.screwdriver"
        case .searchingFiles:
            "magnifyingglass"
        case .readingFiles:
            "doc.text"
        case .runningCommand:
            "terminal"
        case .responding:
            "text.bubble"
        case .waitingForApproval:
            "checkmark.shield"
        case .waitingForClarification:
            "questionmark.bubble"
        case .complete:
            "checkmark"
        case .failed:
            "exclamationmark"
        case .cancelled:
            "xmark"
        }
    }
}
