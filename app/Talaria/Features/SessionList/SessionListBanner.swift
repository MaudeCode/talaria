import SwiftUI
import TalariaKit

/// A tinted notice at the top of the Chats list.
struct SessionListBanner: View {
    let systemImage: String
    let title: LocalizedStringKey
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: systemImage)
                .imageScale(.small)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)

                if let detail {
                    Text(verbatim: detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }

            Spacer()
        }
        .foregroundStyle(.orange)
        .padding(.horizontal, 24)
        .padding(.vertical, 10)
        .background(Color.orange.opacity(0.12))
        .accessibilityElement(children: .combine)
    }
}

/// The server's `agent_storage` state (TAL-830): a degraded state says why the Agent's chats are missing, with the
/// server's reason; `ok` shows nothing.
struct AgentStorageBanner: View {
    let storage: AgentStorage?

    var body: some View {
        if let storage, let title = Self.title(for: storage.state) {
            SessionListBanner(systemImage: "exclamationmark.triangle", title: title, detail: storage.reason)
        }
    }

    private static func title(for state: AgentStorage.State) -> LocalizedStringKey? {
        switch state {
        case .ok: nil
        case .corrupt: "Agent session storage is damaged"
        case .unavailable: "Agent sessions could not be read"
        case .outdated: "Upgrade hermes-agent to list Agent sessions"
        }
    }
}
