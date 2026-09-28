import SwiftUI
import TalariaKit

struct ComposerVoiceRecordingBar: View {
    let elapsed: TimeInterval
    let isCancelArmed: Bool
    let onStop: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color.red)
                .frame(width: 10, height: 10)
                .opacity(isCancelArmed ? 0.4 : 1)

            Text(AudioDurationFormatter.string(from: elapsed))
                .font(.callout.monospacedDigit())
                .foregroundStyle(.primary)

            Spacer(minLength: 8)

            Label(
                isCancelArmed
                    ? String(localized: "Release to cancel")
                    : String(localized: "Slide up to cancel"),
                systemImage: isCancelArmed ? "xmark.circle.fill" : "chevron.up"
            )
            .font(.caption)
            .foregroundStyle(isCancelArmed ? Color.red : Color.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Recording voice note, \(AudioDurationFormatter.string(from: elapsed))"))
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityAction(named: Text("Stop and send"), onStop)
        .accessibilityAction(named: Text("Cancel recording"), onCancel)
    }
}
