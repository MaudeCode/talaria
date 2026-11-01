import SwiftUI

/// The thin capacity rail every quota and share surface draws: a track, a fill up to `percent`, and an optional
/// marker at `markerPercent` (the server's expected position). The sidebar Quotas row, the widget bars, the Insights
/// quota row and the model share row all render through it, so a change to the rail lands everywhere at once.
struct ProgressRailView: View {
    let percent: Double
    var markerPercent: Double? = nil
    var tint: Color = .accentColor
    var trackColor: Color = .secondary.opacity(0.18)
    var height: CGFloat = 3

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(trackColor)
                Capsule()
                    .fill(tint)
                    .frame(width: width * Self.clamped(percent) / 100)
                    .widgetAccentable()
                if let markerPercent {
                    Rectangle()
                        .fill(Color.primary)
                        .frame(width: 1.5)
                        .offset(x: min(max(width * Self.clamped(markerPercent) / 100 - 0.75, 0), max(width - 1.5, 0)))
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }

    private static func clamped(_ value: Double) -> Double {
        min(max(value, 0), 100)
    }
}
