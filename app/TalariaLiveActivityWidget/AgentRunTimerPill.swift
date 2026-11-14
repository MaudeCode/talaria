import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunTimerPill: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(state.isFinal ? palette.color(for: state.status, isStale: state.isStale) : palette.liveDot)
                .frame(width: 5, height: 5)

            if state.isFinal {
                Text("Done")
            } else {
                AgentRunElapsedTimerText(startedAt: state.startedAt, alignment: .center)
            }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(palette.secondaryText)
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(width: 62, alignment: .center)
        .background(palette.fill, in: Capsule(style: .continuous))
        .overlay(Capsule(style: .continuous).stroke(palette.stroke, lineWidth: 1))
    }
}
