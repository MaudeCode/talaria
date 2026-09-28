import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunIslandCompactTrailing: View {
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        Text(state.status.compactTitle)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(AgentRunStatusStyle.color(for: state.status, isStale: state.isStale))
            .minimumScaleFactor(0.72)
            .lineLimit(1)
    }
}
