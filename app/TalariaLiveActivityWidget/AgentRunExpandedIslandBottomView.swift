import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunExpandedIslandBottomView: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: AgentRunActivityAttributes.ContentState
    var publisherID: String? = nil

    var body: some View {
        let actions = LiveActivityRowActions(state: state, publisherID: publisherID)
        VStack(alignment: .leading, spacing: 4) {
            if let actions {
                // The island has no activity line, so a refused answer's error shows with the choices.
                LiveActivityActionButtons(actions: actions, error: state.errorSummary)
                    .controlSize(.small)
            } else if !state.responseExcerpt.isEmpty {
                Text(state.responseExcerpt)
                    .font(.caption2)
                    .foregroundStyle(palette.secondaryText)
                    .lineLimit(2)
                    .truncationMode(.tail)
            } else {
                Text(state.currentActivity)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if actions == nil, let counts = state.workCounts {
                AgentRunWorkCountsLabel(counts: counts, font: .caption2.weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}
