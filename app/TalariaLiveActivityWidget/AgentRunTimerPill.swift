import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunTimerPill: View {
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
