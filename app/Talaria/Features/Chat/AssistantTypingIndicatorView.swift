import SwiftUI
import UIKit
import TalariaKit

struct AssistantTypingIndicatorView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var isBreathing = false

    var body: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 16, height: 16)
            .scaleEffect(reduceMotion ? 1 : (isBreathing ? 1.16 : 0.86))
            .opacity(reduceMotion ? 0.75 : (isBreathing ? 0.95 : 0.55))
            .padding(.leading, 4)
            .padding(.vertical, 8)
            .accessibilityLabel("Talaria is preparing a response")
            .onAppear {
                updateBreathingAnimation()
            }
            .onChange(of: reduceMotion) {
                updateBreathingAnimation()
            }
    }

    private var dotColor: Color {
        colorScheme == .dark ? Color.white.opacity(0.92) : Color.black.opacity(0.78)
    }

    private func updateBreathingAnimation() {
        guard let animation = ChatMotion.typingIndicator(reduceMotion: reduceMotion) else {
            isBreathing = false
            return
        }

        isBreathing = false
        withAnimation(animation) {
            isBreathing = true
        }
    }
}
