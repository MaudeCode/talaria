import SwiftUI
import TalariaKit

struct ActivityGlowText: View {
    let text: String
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if isActive, !reduceMotion {
            ActivityGlowSweep(text: text)
        } else {
            Text(text)
                .foregroundStyle(.secondary)
        }
    }
}

/// A bright band that sweeps across the text every two seconds (TAL-1241). SwiftUI interpolates a repeating offset
/// without re-evaluating the body, so it runs once rather than every display frame; animating the gradient's end points
/// instead leaves the band still. The sweep runs in unit space scaled to the text, so a rotating title's new width keeps
/// the band's path. Its own view, so each activation starts a fresh sweep.
private struct ActivityGlowSweep: View {
    let text: String

    @State private var swept = false
#if DEBUG
    @Environment(\.chatBodyEvaluation) private var recordBodyEvaluation
#endif

    var body: some View {
#if DEBUG
        let _ = recordBodyEvaluation?("activityGlow")
#endif
        Text(text)
            .foregroundStyle(.clear)
            .overlay {
                GeometryReader { proxy in
                    // Three text widths: the band is the middle third and sweeps from left of the text to its right.
                    LinearGradient(
                        stops: [
                            .init(color: .secondary, location: 1 / 3),
                            .init(color: .primary, location: 1 / 2),
                            .init(color: .secondary, location: 2 / 3),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: 3, height: 1)
                    .offset(x: swept ? 0 : -2)
                    .frame(width: 1, height: 1, alignment: .leading)
                    .scaleEffect(x: proxy.size.width, y: proxy.size.height, anchor: .topLeading)
                }
                .mask { Text(text) }
                .accessibilityHidden(true)
            }
            .onAppear {
                withAnimation(.linear(duration: 2).repeatForever(autoreverses: false)) { swept = true }
            }
    }
}
