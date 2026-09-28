import SwiftUI
import UIKit
import TalariaKit

struct OnboardingAgentPromptCard: View {
    let prompt: String
    @Binding var hasCopied: Bool
    @State private var didCopyRecently = false
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView(.vertical, showsIndicators: true) {
                Text(prompt)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.82))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 220)

            Button {
                UIPasteboard.general.string = prompt
                hasCopied = true
                HapticButtonHaptics.tap(style: .light, isEnabled: isHapticsEnabled)
                withAnimation(.easeInOut(duration: 0.2)) {
                    didCopyRecently = true
                }
            } label: {
                Label(didCopyRecently ? String(localized: "Copied") : String(localized: "Copy prompt"), systemImage: didCopyRecently ? "checkmark" : "doc.on.doc")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(OnboardingPrimaryButtonStyle())
            .accessibilityLabel(didCopyRecently ? String(localized: "Agent setup prompt copied") : String(localized: "Copy agent setup prompt"))
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.1), lineWidth: 1)
        )
    }
}
