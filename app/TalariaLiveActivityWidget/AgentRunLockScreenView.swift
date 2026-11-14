import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunLockScreenView: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: AgentRunActivityAttributes.ContentState
    var publisherID: String? = nil

    @Environment(\.agentRunFrozenClock) private var frozenClock

    /// TAL-874: "Updated" stays hidden while the run's last activity is its start.
    private static let updatedQuietInterval: TimeInterval = 10

    var body: some View {
        let actions = LiveActivityRowActions(state: state, publisherID: publisherID)
        // What an approval runs takes the activity line's place, so the text and Allow fit; a refused answer's error,
        // otherwise in the activity line, then shows with the choices.
        let showsApprovalText = if case .approval(_, _?) = actions?.kind { true } else { false }
        VStack(alignment: .leading, spacing: 10) {
            header
            if !showsApprovalText {
                activityRow
            }
            if let actions {
                LiveActivityActionButtons(actions: actions, error: showsApprovalText ? state.errorSummary : nil)
            } else {
                transcriptPanel
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            AgentRunStatusDot(status: state.status, isStale: state.isStale, size: 34)

            VStack(alignment: .leading, spacing: 2) {
                Text("Talaria")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.secondaryText)
                    .textCase(.uppercase)

                Text(state.sessionTitle)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.82)
            }
            .layoutPriority(1)

            Spacer(minLength: 8)

            AgentRunTimerPill(state: state)
        }
    }

    private var activityRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(state.lockScreenLead)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let counts = state.workCounts {
                AgentRunWorkCountsLabel(counts: counts, font: .caption.weight(.semibold))
            }
        }
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            detailText
                .font(.caption)
                .foregroundStyle(palette.secondaryText)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(palette.color(for: state.status, isStale: state.isStale).opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(palette.stroke, lineWidth: 1)
        )
    }

    /// The App's own stream shows its excerpt. Relay never sends one, so its run shows the tool count and how long ago
    /// the run last changed (TAL-874); an older Relay or Web, which sends neither, keeps the earlier wording.
    private var detailText: Text {
        if !state.responseExcerpt.isEmpty {
            return Text(state.responseExcerpt)
        }
        guard let toolCount = state.toolCount else {
            return Text(verbatim: state.isFinal ? "Response is ready to review." : "Waiting for the next agent update.")
        }
        if state.isFinal {
            return Text("Open to read the reply")
        }
        let tools = Text("\(toolCount) tools")
        guard let activityAt = state.activityAt,
              activityAt.timeIntervalSince(state.startedAt) >= Self.updatedQuietInterval else {
            return tools
        }
        // A Live Activity redraws only for a content update or a live date, so the label stays live rather than appearing
        // on a timer. Whole minutes keep its first minute at "now" instead of counting seconds.
        let format = SystemFormatStyle.DateReference(to: activityAt, allowedFields: [.day, .hour, .minute], maxFieldCount: 1)
        let relative = frozenClock.map { Text($0, format: format) } ?? Text(.currentDate, format: format)
        return Text("\(tools) · \(Text("Updated \(relative)"))")
    }
}

/// TAL-1422: the server's plan progress and running workers, "Plan 2/5 · 3 workers", read as a sentence. Shared by the
/// Lock Screen, the expanded island and the aggregate rows.
struct AgentRunWorkCountsLabel: View {
    @Environment(\.liveActivityPalette) private var palette
    let counts: AgentRunWorkCounts
    let font: Font

    var body: some View {
        Text(counts.text)
            .font(font)
            .monospacedDigit()
            .foregroundStyle(palette.secondaryText)
            .lineLimit(1)
            .fixedSize()
            .accessibilityLabel(counts.accessibilityLabel)
    }
}

/// TAL-2037: the small family on the Apple Watch Smart Stack and CarPlay. The status glyph and title, then the timer or
/// the ask or outcome; no excerpt, counts or buttons, so it reads at a glance.
struct AgentRunSmallView: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        let detail = state.smallDetail
        let showsTimer = if case .timer = detail { true } else { false }
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                // The timer names no phase, so the glyph does; a status word already says it.
                AgentRunStatusDot(status: state.status, isStale: state.isStale, size: 20)
                    .accessibilityLabel(state.status.title)
                    .accessibilityHidden(!showsTimer)
                Text(state.sessionTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(1)
            }
            Group {
                switch detail {
                case let .timer(startedAt):
                    AgentRunElapsedTimerText(startedAt: startedAt, alignment: .leading)
                        .foregroundStyle(palette.secondaryText)
                case let .text(text):
                    Text(text)
                        .foregroundStyle(state.isStale ? palette.secondaryText : palette.color(for: state.status, isStale: false))
                }
            }
            .font(.subheadline)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}
