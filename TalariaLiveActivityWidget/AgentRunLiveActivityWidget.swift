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

private struct TalariaAggregateHeader: View {
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        ZStack {
            HStack {
                SandalMark(height: 13)
                Spacer()
            }

            Text(TalariaAggregateLiveActivityPresentation.headerText(
                state: state,
                isStale: isStale
            ))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(isStale
                    ? AgentRunLiveActivityTheme.secondaryText
                    : AggregatePhaseStyle.headerColor(
                        for: state,
                        isLuminanceReduced: isLuminanceReduced
                    ))
                .lineLimit(1)
        }
    }
}

private struct AggregateCompactTrailing: View {
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        if let phase = TalariaAggregateLiveActivityPresentation.signalPhase(
            state: state,
            isStale: isStale
        ) {
            Image(systemName: AggregatePhaseStyle.symbol(for: phase))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(AggregatePhaseStyle.color(
                    for: phase,
                    isLuminanceReduced: isLuminanceReduced
                ))
                .accessibilityLabel(
                    TalariaAggregateLiveActivityPresentation.accessibilityLabel(for: phase)
                )
        } else {
            Text("\(state.activeCount)")
                .font(.system(size: 11, weight: .semibold))
        }
    }

}

private struct AggregateStatusLabel: View {
    let status: String
    let phase: String
    let isStale: Bool
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        Text(TalariaAggregateLiveActivityPresentation.statusText(status, isStale: isStale))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(AggregatePhaseStyle.color(
                for: isStale ? "stale" : phase,
                isLuminanceReduced: isLuminanceReduced
            ))
            .lineLimit(1)
    }
}

private enum AggregatePhaseStyle {
    static func color(
        for phase: String,
        isLuminanceReduced: Bool
    ) -> Color {
        if isLuminanceReduced {
            return AgentRunLiveActivityTheme.secondaryText
        }
        guard let hex = TalariaAggregateLiveActivityPresentation.colorHex(for: phase) else {
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

private struct SandalMark: View {
    let height: CGFloat

    var body: some View {
        Image("Sandal")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
            .frame(width: height * 0.93, height: height)
            .accessibilityHidden(true)
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

private struct AgentRunExpandedIslandBottomView: View {
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AgentRunProgressRail(status: state.status)

            if !state.responseExcerpt.isEmpty {
                Text(state.responseExcerpt)
                    .font(.caption2)
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                    .lineLimit(2)
                    .truncationMode(.tail)
            } else {
                Text(state.currentActivity)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}

private struct AgentRunLockScreenView: View {
    let context: ActivityViewContext<AgentRunActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            activityProgressRow(progressWidth: 112)
            transcriptPanel
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private var activityText: String {
        if context.state.isStale {
            return "Latest status shown"
        }

        if let errorSummary = context.state.errorSummary, !errorSummary.isEmpty {
            return errorSummary
        }

        return context.state.currentActivity
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            AgentRunStatusDot(status: context.state.status, isStale: context.state.isStale, size: 34)

            VStack(alignment: .leading, spacing: 2) {
                Text("Talaria")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                    .textCase(.uppercase)

                Text(context.state.sessionTitle)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.82)
            }
            .layoutPriority(1)

            Spacer(minLength: 8)

            AgentRunTimerPill(state: context.state)
        }
    }

    private func activityProgressRow(progressWidth: CGFloat) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Text(activityText)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .layoutPriority(1)

            Spacer(minLength: 8)

            AgentRunProgressRail(status: context.state.status)
                .frame(width: progressWidth)
        }
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(excerptText)
                .font(.caption)
                .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(AgentRunStatusStyle.color(for: context.state.status, isStale: context.state.isStale).opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(AgentRunLiveActivityTheme.stroke, lineWidth: 1)
        )
    }

    private var excerptText: String {
        if !context.state.responseExcerpt.isEmpty {
            return context.state.responseExcerpt
        }

        if context.state.isFinal {
            return "Response is ready to review."
        }

        return "Waiting for the next agent update."
    }
}

private struct AgentRunIslandBadge: View {
    let status: AgentRunActivityStatus

    var body: some View {
        HStack(spacing: 6) {
            AgentRunStatusDot(status: status, isStale: false)
            Text("Talaria")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
                .lineLimit(1)
        }
    }
}

private struct AgentRunIslandStatusView: View {
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Text(state.status.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AgentRunStatusStyle.color(for: state.status, isStale: state.isStale))
                .lineLimit(1)

            if state.isFinal {
                Text("Ready")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
            } else if state.isStale {
                Text("Latest")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
            } else {
                HStack(spacing: 3) {
                    Circle()
                        .fill(AgentRunLiveActivityTheme.liveDot)
                        .frame(width: 4, height: 4)
                    AgentRunElapsedTimerText(startedAt: state.startedAt, alignment: .trailing)
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
            }
        }
    }
}

private struct AgentRunIslandCompactMark: View {
    let status: AgentRunActivityStatus

    var body: some View {
        ZStack {
            Circle()
                .fill(AgentRunStatusStyle.color(for: status, isStale: false).opacity(0.25))

            Image(systemName: AgentRunStatusStyle.symbolName(for: status))
                .font(.caption2.weight(.bold))
                .foregroundStyle(AgentRunStatusStyle.color(for: status, isStale: false))
        }
        .frame(width: 22, height: 22)
    }
}

private struct AgentRunStatusDot: View {
    let status: AgentRunActivityStatus
    let isStale: Bool
    var size: CGFloat = 22

    var body: some View {
        Image(systemName: symbolName)
            .font(.system(size: size * 0.46, weight: .bold))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(color.opacity(0.18), in: Circle())
            .overlay(Circle().stroke(color.opacity(0.36), lineWidth: 1))
    }

    var color: Color {
        AgentRunStatusStyle.color(for: status, isStale: isStale)
    }

    var symbolName: String {
        AgentRunStatusStyle.symbolName(for: status)
    }
}

private struct AgentRunProgressRail: View {
    let status: AgentRunActivityStatus

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(AgentRunLiveActivityTheme.railBackground)

                Capsule(style: .continuous)
                    .fill(AgentRunStatusStyle.color(for: status, isStale: false))
                    .frame(width: max(12, geometry.size.width * progressFraction))
            }
        }
        .frame(height: 6)
    }

    private var progressFraction: CGFloat {
        switch status {
        case .starting:
            0.14
        case .thinking:
            0.3
        case .usingTool, .searchingFiles, .readingFiles, .runningCommand:
            0.52
        case .waitingForApproval, .waitingForClarification:
            0.62
        case .responding:
            0.78
        case .complete:
            1
        case .failed, .cancelled:
            1
        }
    }
}

private struct AgentRunTimerPill: View {
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(state.isFinal ? AgentRunStatusStyle.color(for: state.status, isStale: state.isStale) : AgentRunLiveActivityTheme.liveDot)
                .frame(width: 5, height: 5)

            if state.isFinal {
                Text("Done")
            } else {
                AgentRunElapsedTimerText(startedAt: state.startedAt, alignment: .center)
            }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(width: 62, alignment: .center)
        .background(AgentRunLiveActivityTheme.pillBackground, in: Capsule(style: .continuous))
        .overlay(Capsule(style: .continuous).stroke(AgentRunLiveActivityTheme.stroke, lineWidth: 1))
    }
}

private struct AgentRunElapsedTimerText: View {
    let startedAt: Date
    var alignment: TextAlignment = .trailing

    // `Text(timerInterval:)` reserves layout width for the largest value its range
    // could ever show, then draws the shorter live value leading-aligned inside that
    // leftover slack — which left-shifted the digits in the Dynamic Island and the
    // Lock Screen pill (#247). Bounding the range keeps an MM:SS-sized box, and an
    // explicit `multilineTextAlignment` pins the digits to the edge each call site
    // wants (trailing under the Dynamic Island status, centered in the pill).
    private static let maxDisplayInterval: TimeInterval = 99 * 60 + 59

    var body: some View {
        Text(
            timerInterval: startedAt...startedAt.addingTimeInterval(Self.maxDisplayInterval),
            countsDown: false,
            showsHours: false
        )
        .monospacedDigit()
        .multilineTextAlignment(alignment)
        .lineLimit(1)
    }
}

private enum AgentRunLiveActivityTheme {
    static let background = Color(red: 0.025, green: 0.028, blue: 0.038)
    static let primaryText = Color.white
    static let secondaryText = Color.white.opacity(0.68)
    static let stroke = Color.white.opacity(0.13)
    static let pillBackground = Color.white.opacity(0.08)
    static let railBackground = Color.white.opacity(0.14)
    static let liveDot = Color(red: 0.35, green: 0.95, blue: 0.7)
}

private enum AgentRunStatusStyle {
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
