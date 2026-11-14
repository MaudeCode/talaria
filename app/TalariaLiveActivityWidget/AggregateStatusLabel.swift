import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AggregateStatusLabel: View {
    @Environment(\.liveActivityPalette) private var palette
    let status: String
    let phase: String
    let isStale: Bool

    var body: some View {
        Text(TalariaAggregateLiveActivityPresentation.statusText(status, isStale: isStale))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(palette.color(forPhase: isStale ? "stale" : phase))
            .lineLimit(1)
    }
}
