import SwiftUI
import TalariaKit

/// One pending update's "Summarize with AI" request (TAL-759): the server summarizes its own last check of the target,
/// from the release notes it installs on Stable, and returns display-ready sections.
@MainActor
@Observable
final class UpdateSummaryModel {
    enum Phase: Equatable {
        case loading
        case loaded([UpdatesSummaryResponse.Section])
        case failed
    }

    let target: UpdateTarget
    private(set) var phase: Phase = .loading
    @ObservationIgnored private let client: APIClient

    init(target: UpdateTarget, client: APIClient) {
        self.target = target
        self.client = client
    }

    func load() async {
        phase = .loading
        do {
            phase = try await .loaded(client.updatesSummary(target: target).summarySections)
        } catch {
            phase = .failed
        }
    }
}

/// The bottom sheet "Summarize with AI" opens: the server's sections, progress while it writes them, Retry on failure.
struct UpdateSummarySheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var model: UpdateSummaryModel
    let name: String
    /// Installed → target version, when the server reports both.
    let range: String?

    var body: some View {
        NavigationStack {
            List {
                if let range {
                    Text(range)
                        .foregroundStyle(.secondary)
                }
                switch model.phase {
                case .loading:
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Summarizing what's new…")
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                case .failed:
                    Label("Couldn't summarize what's new.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    Button("Retry") {
                        Task { await model.load() }
                    }
                case let .loaded(sections):
                    ForEach(sections, id: \.self) { section in
                        Section(section.title) {
                            ForEach(section.items, id: \.self) { item in
                                Text(item)
                            }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "What's new in \(name)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await model.load() }
        .presentationDetents([.medium, .large])
        .adaptiveFormPresentation()
    }
}

/// "Summarize with AI" for one update target; shown only when the server offers a summary.
struct UpdateSummaryButton: View {
    let info: UpdateTargetInfo?
    let action: () -> Void

    var body: some View {
        if info?.offersSummary == true {
            SettingsButton(String(localized: "Summarize with AI"), action: action)
                .padding(.top, 4)
        }
    }
}

/// A presented summary: which target, and the words its sheet shows.
struct UpdateSummaryRequest: Identifiable {
    let target: UpdateTarget
    let name: String
    let range: String?

    var id: UpdateTarget { target }

    init(target: UpdateTarget, info: UpdateTargetInfo?) {
        self.target = target
        name = target == .webui ? String(localized: "Talaria Web") : String(localized: "Hermes Agent")
        range = info?.versionRange
    }
}

extension UpdateTargetInfo {
    /// "installed → target" when the server reports both.
    var versionRange: String? {
        guard let currentVersion, let targetVersion else { return nil }
        return "\(currentVersion) → \(targetVersion)"
    }
}

/// A status line under the Agent update row: the server's state in words, and the icon beside them.
struct UpdateNote {
    let text: String
    let systemImage: String
    let tint: Color

    init(agent: UpdateTargetInfo) {
        switch agent.state {
        case "release_ready":
            text = agent.targetVersion.map { String(localized: "\($0) available") }
                ?? String(localized: "Update available")
            (systemImage, tint) = ("arrow.up.circle", .blue)
        case "commits_behind":
            text = String(localized: "\(agent.behind ?? 0) commits behind")
            (systemImage, tint) = ("arrow.up.circle", .blue)
        case "up_to_date":
            text = String(localized: "Up to date")
            (systemImage, tint) = ("checkmark.circle", .secondary)
        case "finish", "manual", "local_changes":
            text = String(localized: "Update on the server")
            (systemImage, tint) = ("exclamationmark.triangle", .orange)
        case "check_failed":
            text = String(localized: "Couldn't check for updates")
            (systemImage, tint) = ("exclamationmark.triangle", .orange)
        case "off":
            text = String(localized: "Update checks are off")
            (systemImage, tint) = ("minus.circle", .secondary)
        default:
            text = String(localized: "Unknown")
            (systemImage, tint) = ("questionmark.circle", .secondary)
        }
    }
}
