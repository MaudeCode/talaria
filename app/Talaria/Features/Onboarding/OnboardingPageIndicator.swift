import SwiftUI
import UIKit

/// The page dots of onboarding and of a paged What's New (TAL-2173): the current page as a wide capsule.
struct OnboardingPageIndicator: View {
    let pageCount: Int
    let currentPage: Int
    var color: Color = .white
    var otherColor: Color = .white.opacity(0.18)

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<pageCount, id: \.self) { index in
                Capsule()
                    .fill(index == currentPage ? color : otherColor)
                    .frame(width: index == currentPage ? 24 : 8, height: 8)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: currentPage)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "Page \(currentPage + 1) of \(pageCount)"))
        .accessibilityRespondsToUserInteraction(false)
    }
}
