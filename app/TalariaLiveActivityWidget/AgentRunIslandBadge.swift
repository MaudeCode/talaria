import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunIslandBadge: View {
    @Environment(\.liveActivityPalette) private var palette
    let status: AgentRunActivityStatus

    var body: some View {
        HStack(spacing: 6) {
            AgentRunStatusDot(status: status, isStale: false)
            Text("Talaria")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.primaryText)
                .lineLimit(1)
        }
    }
}
