import SwiftUI

struct ActiveSessionStreamingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded = false

    var body: some View {
        Circle()
            .fill(.green)
            .frame(width: 9, height: 9)
            .scaleEffect(reduceMotion ? 1 : (isExpanded ? 1.4 : 1.0))
            .accessibilityHidden(true)
            .onAppear {
                updateAnimation()
            }
            .onChange(of: reduceMotion) {
                updateAnimation()
            }
            .onDisappear {
                isExpanded = false
            }
    }

    private func updateAnimation() {
        guard !reduceMotion else {
            isExpanded = false
            return
        }

        isExpanded = false
        withAnimation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true)) {
            isExpanded = true
        }
    }
}
