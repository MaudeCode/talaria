import SwiftUI
import TalariaKit

struct ComposerVoiceControlButton: View {
    let isListening: Bool
    let isDisabled: Bool
    let color: Color
    let isRecordingVoiceNote: Bool
    let onTap: () -> Void
    let onRecordingStart: () -> Void
    let onRecordingDragChanged: (CGFloat) -> Void
    let onRecordingEnd: (CGFloat) -> Void

    @State private var isPressing = false
    @State private var didTriggerRecording = false
    @State private var holdWorkItem: DispatchWorkItem?

    var body: some View {
        Image(systemName: symbolName)
            .font(.system(size: 18, weight: .regular))
            .frame(width: 28, height: 28)
            .chatMinimumHitTarget(in: Circle())
            .foregroundStyle(isListening || isRecordingVoiceNote ? Color.red : color)
            .scaleEffect(isRecordingVoiceNote ? 1.3 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isRecordingVoiceNote)
            .contentShape(Circle())
            .opacity(isDisabled && !isRecordingVoiceNote ? 0.4 : 1)
            .gesture(pressGesture)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                // Default VoiceOver activation (double-tap) toggles dictation.
                // VoiceOver synthesizes an activation rather than a real touch, so
                // the gesture's tap path never fires for it; without this the
                // dictation toggle is unreachable for VoiceOver users.
                if !isDisabled { onTap() }
            }
            .accessibilityAction(named: Text("Record voice note")) {
                // VoiceOver can't hold-to-talk, so this starts recording; the
                // recording bar then exposes "Stop and send" / "Cancel" actions.
                onRecordingStart()
            }
    }

    private var symbolName: String {
        if isRecordingVoiceNote { return "mic.fill" }
        return isListening ? "stop.circle.fill" : "mic"
    }

    private var accessibilityLabel: Text {
        if isRecordingVoiceNote { return Text("Recording voice note") }
        return isListening ? Text("Stop voice input") : Text("Voice input")
    }

    /// One `DragGesture(minimumDistance: 0)` distinguishes tap from hold by timing,
    /// which is far more reliable than composing `LongPressGesture`/`TapGesture`/
    /// `highPriorityGesture` (those let the press keep claiming the touch so the tap
    /// never wins). Touch-down schedules a delayed "start recording"; a release
    /// before the delay cancels it and counts as a tap → dictation. A perfectly
    /// still hold still records because the delay is timer-driven, not movement-driven.
    private var pressGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if !isPressing {
                    isPressing = true
                    scheduleRecordingStart()
                }
                if isRecordingVoiceNote {
                    onRecordingDragChanged(value.translation.height)
                }
            }
            .onEnded { value in
                cancelScheduledRecordingStart()
                let triggered = didTriggerRecording
                isPressing = false
                didTriggerRecording = false

                if triggered {
                    onRecordingEnd(value.translation.height)
                } else if !isDisabled {
                    onTap()
                }
            }
    }

    private func scheduleRecordingStart() {
        didTriggerRecording = false
        let item = DispatchWorkItem {
            didTriggerRecording = true
            onRecordingStart()
        }
        holdWorkItem = item
        DispatchQueue.main.asyncAfter(
            deadline: .now() + ComposerVoiceNoteGesture.holdActivationDelay,
            execute: item
        )
    }

    private func cancelScheduledRecordingStart() {
        holdWorkItem?.cancel()
        holdWorkItem = nil
    }
}
