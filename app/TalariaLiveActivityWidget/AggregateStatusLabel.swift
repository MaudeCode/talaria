import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AggregateStatusLabel: View {
    let status: String
    let phase: String
    let isStale: Bool
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        Text(TalariaAggregateLiveActivityPresentation.statusText(status, isStale: isStale))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(AggregatePhaseStyle.color(
                for: isStale ? "stale" : phase,
                isLuminanceReduced: isLuminanceReduced
            ))
            .lineLimit(1)
    }
}
