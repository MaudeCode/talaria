import AVFoundation
import SwiftUI
import TalariaKit

/// A compact, Telegram-style inline audio player used both in the chat bubble
/// and in the full-screen attachment preview. Bytes are fetched lazily via the
/// injected `load` closure — the same authenticated raw-file route the image
/// loader uses — then played with `AVAudioPlayer`. Starting one player pauses
/// any other that's currently playing (see `AudioAttachmentPlaybackCenter`).
struct InlineAudioPlayerView: View {
    /// Accessibility / labelling name for the clip (typically the file name).
    let title: String
    /// Lazily fetches the raw audio bytes; returns `nil` on failure.
    let load: () async -> Data?

    @State private var model = InlineAudioPlayerModel()

    var body: some View {
        HStack(spacing: 12) {
            controlButton

            VStack(alignment: .leading, spacing: 4) {
                if model.phase == .failed {
                    Text("Couldn't play this audio")
                        .font(AppFont.caption2())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    scrubber
                    timeRow
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(.separator).opacity(0.25), lineWidth: 0.5)
        )
        .task {
            await model.loadIfNeeded(using: load)
        }
        .onDisappear {
            model.teardown()
        }
    }

    @ViewBuilder
    private var controlButton: some View {
        switch model.phase {
        case .idle, .loading:
            ZStack {
                Circle().fill(Color.accentColor.opacity(0.15))
                ProgressView().tint(Color.accentColor)
            }
            .frame(width: 40, height: 40)
            .accessibilityLabel(String(localized: "Loading audio"))

        case .ready:
            Button {
                model.togglePlayPause()
            } label: {
                ZStack {
                    Circle().fill(Color.accentColor)
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 40, height: 40)
            }
            .buttonStyle(.chatTactile(.icon))
            .accessibilityLabel(
                model.isPlaying
                    ? String(localized: "Pause \(title)")
                    : String(localized: "Play \(title)")
            )

        case .failed:
            ZStack {
                Circle().fill(Color(.systemFill))
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(width: 40, height: 40)
            .accessibilityLabel(String(localized: "Audio unavailable"))
        }
    }

    private var scrubber: some View {
        Slider(
            value: Binding(
                get: { model.displayTime },
                set: { model.scrub(to: $0) }
            ),
            in: 0...max(model.duration, 0.01),
            onEditingChanged: { editing in
                model.setScrubbing(editing)
            }
        )
        .tint(Color.accentColor)
        .disabled(model.phase != .ready)
        .accessibilityLabel(String(localized: "Playback position for \(title)"))
    }

    private var timeRow: some View {
        HStack(spacing: 8) {
            Text(AudioDurationFormatter.string(from: model.displayTime))
            Spacer(minLength: 8)
            Text(AudioDurationFormatter.string(from: model.duration))
        }
        .font(AppFont.caption2().monospacedDigit())
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
}
