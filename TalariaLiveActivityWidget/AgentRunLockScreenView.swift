import ActivityKit
import SwiftUI
import WidgetKit

struct AgentRunLockScreenView: View {
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
