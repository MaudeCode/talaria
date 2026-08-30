import SwiftUI
import UIKit


struct SetupStepRow: View {
    let number: String
    let title: String
    let subtitle: String
    var command: String?
    var commandPrefix: String? = "$"
    var copyValue: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.caption.weight(.bold))
                .foregroundStyle(.black)
                .frame(width: 23, height: 23)
                .background(Color(red: 1.0, green: 0.74, blue: 0.10), in: Circle())
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 7) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)

                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.5))
                    .fixedSize(horizontal: false, vertical: true)

                if let command {
                    OnboardingCommandPill(text: command, prefix: commandPrefix, copyValue: copyValue)
                }
            }
        }
    }
}




struct OnboardingPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.black)
            .lineLimit(1)
            .minimumScaleFactor(0.78)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 10)
            .padding(.vertical, 15)
            .background(Color(red: 1.0, green: 0.74, blue: 0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(configuration.isPressed ? 0.78 : 1)
    }
}




struct OnboardingSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white.opacity(0.84))
            .lineLimit(1)
            .minimumScaleFactor(0.78)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 10)
            .padding(.vertical, 15)
            .background(Color.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.white.opacity(0.1), lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}
