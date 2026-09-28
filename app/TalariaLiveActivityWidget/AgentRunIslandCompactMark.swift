import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunIslandCompactMark: View {
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
