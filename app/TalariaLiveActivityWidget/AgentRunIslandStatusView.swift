import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunIslandStatusView: View {
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
