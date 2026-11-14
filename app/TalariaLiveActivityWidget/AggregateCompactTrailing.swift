import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AggregateCompactTrailing: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if let phase = TalariaAggregateLiveActivityPresentation.signalPhase(
            state: state,
            isStale: isStale
        ) {
            Image(systemName: TalariaAggregateLiveActivityPresentation.signalSymbol(for: phase))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(palette.color(forPhase: phase))
                .widgetAccentable()
                .accessibilityLabel(
                    TalariaAggregateLiveActivityPresentation.accessibilityLabel(for: phase)
                )
        } else {
            Text("\(state.activeCount)")
                .font(.system(size: 11, weight: .semibold))
        }
    }

}
