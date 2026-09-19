import SwiftUI

struct ActivityGlowText: View {
    let text: String
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if isActive, !reduceMotion {
            TimelineView(.animation) { context in
                let progress = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 2) / 2
                Text(text)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.secondary, .primary, .secondary],
                            startPoint: UnitPoint(x: progress * 2 - 1, y: 0.5),
                            endPoint: UnitPoint(x: progress * 2, y: 0.5)
                        )
                    )
            }
        } else {
            Text(text)
                .foregroundStyle(.secondary)
        }
    }
}
