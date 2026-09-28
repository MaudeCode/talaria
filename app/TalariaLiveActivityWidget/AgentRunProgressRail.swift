import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunProgressRail: View {
    let status: AgentRunActivityStatus

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(AgentRunLiveActivityTheme.railBackground)

                Capsule(style: .continuous)
                    .fill(AgentRunStatusStyle.color(for: status, isStale: false))
                    .frame(width: max(12, geometry.size.width * progressFraction))
            }
        }
        .frame(height: 6)
    }

    private var progressFraction: CGFloat {
        switch status {
        case .starting:
            0.14
        case .thinking:
            0.3
        case .usingTool, .searchingFiles, .readingFiles, .runningCommand:
            0.52
        case .waitingForApproval, .waitingForClarification:
            0.62
        case .responding:
            0.78
        case .complete:
            1
        case .failed, .cancelled:
            1
        }
    }
}
