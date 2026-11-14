import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunStatusDot: View {
    @Environment(\.liveActivityPalette) private var palette
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
            .widgetAccentable()
    }

    var color: Color {
        palette.color(for: status, isStale: isStale)
    }

    var symbolName: String {
        AgentRunStatusStyle.symbolName(for: status)
    }
}
