import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunLockScreenView: View {
    let state: AgentRunActivityAttributes.ContentState
    var publisherID: String? = nil

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
                    .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                    .textCase(.uppercase)

                Text(state.sessionTitle)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
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
        Text(state.lockScreenLead)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(excerptText)
                .font(.caption)
                .foregroundStyle(AgentRunLiveActivityTheme.secondaryText)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(AgentRunStatusStyle.color(for: state.status, isStale: state.isStale).opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(AgentRunLiveActivityTheme.stroke, lineWidth: 1)
        )
    }

    private var excerptText: String {
        if !state.responseExcerpt.isEmpty {
            return state.responseExcerpt
        }

        if state.isFinal {
            return "Response is ready to review."
        }

        return "Waiting for the next agent update."
    }
}
