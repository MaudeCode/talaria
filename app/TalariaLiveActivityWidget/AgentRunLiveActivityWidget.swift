import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

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
                        : context.state.activeCount == 0
                            ? TalariaAggregateLiveActivityPresentation.outcomeTitle(context.state)
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
            AgentRunLockScreenView(state: context.state)
                .activityBackgroundTint(AgentRunLiveActivityTheme.background)
                .activitySystemActionForegroundColor(AgentRunLiveActivityTheme.primaryText)
                .widgetURL(TalariaDeepLink.sessionURL(sessionID: context.state.sessionID, publisherID: context.attributes.relayPublisherID))
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
                AgentRunIslandCompactTrailing(state: context.state)
            } minimal: {
                AgentRunIslandCompactMark(status: context.state.status)
            }
            .widgetURL(TalariaDeepLink.sessionURL(sessionID: context.state.sessionID, publisherID: context.attributes.relayPublisherID))
            .keylineTint(AgentRunStatusStyle.color(for: context.state.status, isStale: context.state.isStale))
        }
    }
}
