import SwiftUI
import TalariaKit

/// A chat run status: the pill above the composer and the chips at the transcript tail.
struct RunStatusChip: View {
    let presentation: ChatActiveRunStatusPresentation
    let agentName: String

    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    init(_ presentation: ChatActiveRunStatusPresentation, agentName: String) {
        self.presentation = presentation
        self.agentName = agentName
    }

    var body: some View {
        if voiceOverEnabled, presentation.runStartedAt != nil {
            // The spoken elapsed time is text, so keep it current for whenever VoiceOver lands here.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                chip(now: context.date)
            }
        } else {
            chip(now: .now)
        }
    }

    private func chip(now: Date) -> some View {
        StatusChip(
            label: presentation.label(agentName: agentName),
            accessibilityLabel: presentation.accessibilityLabel(agentName: agentName),
            icon: .activity,
            elapsedSince: presentation.runStartedAt
        )
        .accessibilityValue(presentation.accessibilityElapsedTime(now: now) ?? "")
    }
}
