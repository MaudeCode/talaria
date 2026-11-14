import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct TalariaAggregateHeader: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: TalariaAggregateActivityAttributes.ContentState
    let isStale: Bool

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
                    ? palette.secondaryText
                    : palette.headerColor(for: state))
                .lineLimit(1)
        }
    }
}
