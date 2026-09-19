import SwiftUI
import UIKit

struct OnboardingStepHeader: View {
    let stepNumber: Int
    let icon: String
    let title: String
    let description: String

    private let accent = Color(red: 1.0, green: 0.74, blue: 0.10)

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: icon)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(.white)
                .frame(width: 80, height: 80)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(accent.opacity(0.35), lineWidth: 1)
                )
                .accessibilityHidden(true)

            VStack(spacing: 10) {
                Text("STEP \(stepNumber)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(accent.opacity(0.8))
                    .kerning(1.5)

                Text(title)
                    .font(.title.weight(.bold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)

                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.45))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
