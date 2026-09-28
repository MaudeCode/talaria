import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunExpandedIslandBottomView: View {
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AgentRunProgressRail(status: state.status)

            if !state.responseExcerpt.isEmpty {
                Text(state.responseExcerpt)
                    .font(.caption2)
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                    .lineLimit(2)
                    .truncationMode(.tail)
            } else {
                Text(state.currentActivity)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}
