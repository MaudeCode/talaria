import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunIslandCompactMark: View {
    @Environment(\.liveActivityPalette) private var palette
    let status: AgentRunActivityStatus

    var body: some View {
        ZStack {
            Circle()
                .fill(palette.color(for: status, isStale: false).opacity(0.25))

            Image(systemName: AgentRunStatusStyle.symbolName(for: status))
                .font(.caption2.weight(.bold))
                .foregroundStyle(palette.color(for: status, isStale: false))
        }
        .frame(width: 22, height: 22)
        .widgetAccentable()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.title)
    }
}
