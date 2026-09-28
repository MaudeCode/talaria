import SwiftUI
import TalariaKit

struct RotatingActivityTitle: View {
    let fallback: String
    let titles: [String]
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var titleIndex = 0

    var body: some View {
        ActivityGlowText(
            text: ReasoningTitleRotation.displayedTitle(
                titles: titles,
                index: titleIndex,
                isActive: isActive
            ) ?? fallback,
            isActive: isActive
        )
        .task(id: rotationTaskID) {
            titleIndex = 0
            guard ReasoningTitleRotation.shouldRotate(
                isActive: isActive,
                reduceMotion: reduceMotion,
                titleCount: titles.count
            ) else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(1.5))
                } catch {
                    return
                }
                titleIndex = (titleIndex + 1) % titles.count
            }
        }
    }

    private var rotationTaskID: String {
        "\(isActive)|\(reduceMotion)|\(titles.joined(separator: "\u{1F}"))"
    }
}
