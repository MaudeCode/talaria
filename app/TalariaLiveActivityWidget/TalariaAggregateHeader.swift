import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct TalariaAggregateHeader: View {
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        ZStack {
            HStack {
                SandalMark(height: 13)
                Spacer()
            }

            Text(TalariaAggregateLiveActivityPresentation.headerText(
                state: state,
                isStale: isStale
            ))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(isStale
                    ? AgentRunLiveActivityTheme.secondaryText
                    : AggregatePhaseStyle.headerColor(
                        for: state,
                        isLuminanceReduced: isLuminanceReduced
                    ))
                .lineLimit(1)
        }
    }
}
