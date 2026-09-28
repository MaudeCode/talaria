import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AggregateCompactTrailing: View {
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        if let phase = TalariaAggregateLiveActivityPresentation.signalPhase(
            state: state,
            isStale: isStale
        ) {
            Image(systemName: AggregatePhaseStyle.symbol(for: phase))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(AggregatePhaseStyle.color(
                    for: phase,
                    isLuminanceReduced: isLuminanceReduced
                ))
                .accessibilityLabel(
                    TalariaAggregateLiveActivityPresentation.accessibilityLabel(for: phase)
                )
        } else {
            Text("\(state.activeCount)")
                .font(.system(size: 11, weight: .semibold))
        }
    }

}
