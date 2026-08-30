import SwiftUI

struct LoadOlderMessagesButton: View {
    let isLoading: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.caption.weight(.semibold))
                        .accessibilityHidden(true)
                }

                Text(isLoading ? String(localized: "Loading older messages") : String(localized: "Load older messages"))
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.88)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(Color(.separator).opacity(0.32), lineWidth: 0.5)
            )
        }
        .buttonStyle(.chatTactile(.capsule))
        .disabled(isLoading)
        .frame(maxWidth: .infinity)
        .accessibilityLabel(isLoading ? String(localized: "Loading older messages") : String(localized: "Load older messages"))
    }
}
