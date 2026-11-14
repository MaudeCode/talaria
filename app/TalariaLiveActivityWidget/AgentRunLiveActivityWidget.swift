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
        NewChatControl()
        NewChatVoiceControl()
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
                TalariaAggregateRows(
                    state: context.state, isStale: isStale,
                    limit: TalariaAggregateLiveActivityPresentation.lockScreenRowLimit, spacing: 6
                )
            }
            .padding(14)
            .liveActivityPalette(on: .lockScreen)
            .activityBackgroundTint(LiveActivityPalette.Surface.lockScreen.backgroundTint)
            .activitySystemActionForegroundColor(LiveActivityPalette.Surface.lockScreen.actionForeground)
            .widgetURL(context.state.rows.first?.sessionURL)
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
                    .liveActivityPalette(on: .darkCard)
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
                        .liveActivityPalette(on: .darkCard)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    TalariaAggregateRows(
                        state: context.state, isStale: isStale,
                        limit: TalariaAggregateLiveActivityPresentation.expandedIslandRowLimit, spacing: 5
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .liveActivityPalette(on: .darkCard)
                }
            } compactLeading: {
                SandalMark(height: 16)
                    .liveActivityPalette(on: .darkCard)
            } compactTrailing: {
                AggregateCompactTrailing(state: context.state, isStale: isStale)
                    .liveActivityPalette(on: .darkCard)
            } minimal: {
                SandalMark(height: 13)
                    .liveActivityPalette(on: .darkCard)
            }
            .widgetURL(context.state.rows.first?.sessionURL)
        }
    }
}

struct AgentRunLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentRunActivityAttributes.self) { context in
            AgentRunLockScreenView(state: context.state, publisherID: context.attributes.relayPublisherID)
                .liveActivityPalette(on: .lockScreen)
                .activityBackgroundTint(LiveActivityPalette.Surface.lockScreen.backgroundTint)
                .activitySystemActionForegroundColor(LiveActivityPalette.Surface.lockScreen.actionForeground)
                .widgetURL(TalariaDeepLink.sessionURL(sessionID: context.state.sessionID, publisherID: context.attributes.relayPublisherID))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgentRunIslandBadge(status: context.state.status)
                        .padding(.leading, 18)
                        .liveActivityPalette(on: .darkCard)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    AgentRunIslandStatusView(state: context.state)
                        .padding(.trailing, 18)
                        .liveActivityPalette(on: .darkCard)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    AgentRunExpandedIslandBottomView(state: context.state, publisherID: context.attributes.relayPublisherID)
                        .liveActivityPalette(on: .darkCard)
                }
            } compactLeading: {
                AgentRunIslandCompactMark(status: context.state.status)
                    .liveActivityPalette(on: .darkCard)
            } compactTrailing: {
                AgentRunIslandCompactTrailing(state: context.state)
                    .liveActivityPalette(on: .darkCard)
            } minimal: {
                AgentRunIslandCompactMark(status: context.state.status)
                    .liveActivityPalette(on: .darkCard)
            }
            .widgetURL(TalariaDeepLink.sessionURL(sessionID: context.state.sessionID, publisherID: context.attributes.relayPublisherID))
            // The keyline rings the black island, so it keeps the dark card's hues.
            .keylineTint(LiveActivityPalette.darkCard.color(for: context.state.status, isStale: context.state.isStale))
        }
    }
}
