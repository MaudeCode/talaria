import ActivityKit
import SwiftUI
import WidgetKit

struct AgentRunElapsedTimerText: View {
    let startedAt: Date
    var alignment: TextAlignment = .trailing

    // `Text(timerInterval:)` reserves layout width for the largest value its range
    // could ever show, then draws the shorter live value leading-aligned inside that
    // leftover slack — which left-shifted the digits in the Dynamic Island and the
    // Lock Screen pill (#247). Bounding the range keeps an MM:SS-sized box, and an
    // explicit `multilineTextAlignment` pins the digits to the edge each call site
    // wants (trailing under the Dynamic Island status, centered in the pill).
    private static let maxDisplayInterval: TimeInterval = 99 * 60 + 59

    var body: some View {
        Text(
            timerInterval: startedAt...startedAt.addingTimeInterval(Self.maxDisplayInterval),
            countsDown: false,
            showsHours: false
        )
        .monospacedDigit()
        .multilineTextAlignment(alignment)
        .lineLimit(1)
    }
}
