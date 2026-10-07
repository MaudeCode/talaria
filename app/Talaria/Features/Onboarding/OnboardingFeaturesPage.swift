import SwiftUI

struct OnboardingFeaturesPage: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private let features: [(icon: String, color: Color, title: String, subtitle: String)] = [
        ("bubble.left.and.bubble.right.fill", Color(red: 1.0, green: 0.74, blue: 0.10), String(localized: "Chat with your Hermes agent from iPhone"), String(localized: "Drive conversations from anywhere on your tailnet.")),
        ("list.bullet.rectangle.portrait.fill", .green, String(localized: "Manage sessions, tasks, and files remotely"), String(localized: "Browse workspaces and stay on top of agent work.")),
        ("mic.fill", .purple, String(localized: "Voice input and mobile-friendly composer controls"), String(localized: "Compose naturally with touch-first controls.")),
        ("checkmark.shield.fill", .cyan, String(localized: "Review approvals and clarifications inline"), String(localized: "Respond to agent prompts without switching apps.")),
        ("server.rack", .orange, String(localized: "Self-hosted: your machine, your tailnet"), String(localized: "Your Hermes Web UI stays on hardware you control."))
    ]

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: dynamicTypeSize.isAccessibilitySize ? 28 : 36) {
                VStack(spacing: 10) {
                    Text("What you get")
                        .font(.system(size: dynamicTypeSize.isAccessibilitySize ? 26 : 28, weight: .bold))
                        .foregroundStyle(.white)

                    Text("Your Hermes agent, reachable from iPhone over Tailscale.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.45))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 24)

                VStack(spacing: 16) {
                    ForEach(Array(features.enumerated()), id: \.offset) { _, feature in
                        OnboardingFeatureRow(
                            icon: feature.icon,
                            color: feature.color,
                            title: feature.title,
                            subtitle: feature.subtitle
                        )
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 24)
            .onboardingReadableWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}
