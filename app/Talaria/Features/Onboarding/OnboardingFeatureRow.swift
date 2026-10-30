import SwiftUI

/// An icon, a title and one line of benefit: onboarding's feature list and the What's New sheet (TAL-182).
struct OnboardingFeatureRow: View {
    /// Onboarding draws on its own always-dark backdrop; the announcement follows the app's light or dark theme.
    enum Style {
        case onboarding
        case announcement
    }

    let icon: String
    let color: Color
    let title: String
    let subtitle: String
    var style: Style = .onboarding

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: style == .onboarding ? 14 : 18, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 40, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(color.opacity(0.12))
                )
                // The title says what the row is; the symbol only decorates it.
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(style == .onboarding ? .subheadline.weight(.semibold) : .headline)
                    .foregroundStyle(style == .onboarding ? Color.white : Color.primary)
                    .fixedSize(horizontal: false, vertical: true)

                Text(subtitle)
                    .font(style == .onboarding ? .caption : .subheadline)
                    .foregroundStyle(style == .onboarding ? Color.white.opacity(0.4) : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
