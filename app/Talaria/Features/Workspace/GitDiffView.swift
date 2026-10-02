import SwiftUI
import TalariaKit

struct GitDiffView: View {
    let onAPIError: (Error) -> Void

    private let session: SessionSummary
    private let file: GitFile
    private let apiClient: APIClient
    @State private var diff: GitDiff?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var hasLoaded = false
    @State private var collapsedHunks: Set<Int> = []
    @Environment(\.dismiss) private var dismiss

    init(session: SessionSummary, server: URL, file: GitFile, onAPIError: @escaping (Error) -> Void) {
        self.session = session
        self.file = file
        self.apiClient = APIClient(baseURL: server)
        self.onAPIError = onAPIError
    }

    var body: some View {
        NavigationStack {
            content
                .adaptiveReadableScrollContent(maxWidth: AdaptiveReadableContentWidth.workspace)
                .navigationTitle(file.displayPath)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                }
                .task {
                    guard !hasLoaded else { return }
                    hasLoaded = true
                    await load()
                }
                .refreshesLive(on: .runEnded, showsStatus: diff != nil) {
                    await load()
                }
        }
        .presentationDetents([.medium, .large])
        .adaptivePagePresentation()
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && diff == nil {
            ProgressView("Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if errorMessage != nil && diff == nil {
            ContentUnavailableView {
                Label("Could Not Load Changes", systemImage: "exclamationmark.triangle")
            } description: {
                if let errorMessage { Text(errorMessage) }
            } actions: {
                Button("Try Again") { Task { await load() } }
            }
        } else if let diff {
            diffBody(diff)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func diffBody(_ diff: GitDiff) -> some View {
        if diff.binary == true {
            ContentUnavailableView("Binary file changed", systemImage: "doc.badge.gearshape")
        } else if diff.tooLarge == true {
            ContentUnavailableView("Diff too large to show.", systemImage: "doc.badge.exclamationmark")
        } else {
            let hunks = DiffHunk.parse(diff.diff ?? "")
            if hunks.isEmpty {
                ContentUnavailableView("No Changes", systemImage: "checkmark.circle")
            } else {
                VStack(spacing: 0) {
                    summary(diff: diff, hunks: hunks)
                    GeometryReader { proxy in
                        ScrollView([.horizontal, .vertical]) {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(hunks) { hunk in
                                    hunkHeader(hunk)
                                    if !collapsedHunks.contains(hunk.id) {
                                        ForEach(hunk.lines) { DiffLineRow(line: $0) }
                                    }
                                }
                            }
                            // Pin the content to at least the viewport width so short lines
                            // still get full-width row backgrounds; longer lines scroll.
                            .frame(minWidth: proxy.size.width, alignment: .leading)
                            .textSelection(.enabled)
                        }
                        .environment(\.layoutDirection, .leftToRight)
                    }
                }
            }
        }
    }

    private func summary(diff: GitDiff, hunks: [DiffHunk]) -> some View {
        HStack(spacing: 10) {
            Text("1 file changed").font(AppFont.subheadline(weight: .semibold))
            DiffCountsLabel(
                additions: diff.additions ?? hunks.reduce(0) { $0 + $1.additions },
                deletions: diff.deletions ?? hunks.reduce(0) { $0 + $1.deletions }
            )
            Spacer()
            Button(collapsedHunks.count == hunks.count ? "Expand All" : "Collapse All") {
                withAnimation(.easeInOut(duration: 0.18)) {
                    if collapsedHunks.count == hunks.count {
                        collapsedHunks.removeAll()
                    } else {
                        collapsedHunks = Set(hunks.map(\.id))
                    }
                }
            }
            .font(AppFont.mono(style: .caption))
            .foregroundStyle(.blue)
        }
        .padding(12)
        .background(Color(.systemBackground))
    }

    private func hunkHeader(_ hunk: DiffHunk) -> some View {
        let collapsed = collapsedHunks.contains(hunk.id)
        return Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                if collapsed { collapsedHunks.remove(hunk.id) } else { collapsedHunks.insert(hunk.id) }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                Text(hunk.displayLabel)
                    .font(AppFont.mono(style: .caption))
                DiffCountsLabel(additions: hunk.additions, deletions: hunk.deletions)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemBackground))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(hunk.displayLabel))
        .accessibilityHint(Text(collapsed ? "Expand section" : "Collapse section"))
    }

    private func load() async {
        guard let sessionID = session.sessionId else {
            errorMessage = String(localized: "Session ID is missing.")
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            diff = try await apiClient.gitDiff(
                sessionID: sessionID,
                path: file.displayPath,
                kind: file.preferredDiffKind
            ).diff
        } catch {
            errorMessage = error.localizedDescription
            onAPIError(error)
        }
        isLoading = false
    }
}

extension DiffLine.Kind {
    var rowBackground: Color {
        switch self {
        case .addition: return Color(red: 0.20, green: 0.78, blue: 0.35).opacity(0.16)
        case .deletion: return Color(red: 0.95, green: 0.25, blue: 0.25).opacity(0.16)
        case .context: return Color(.systemBackground)
        }
    }

    var gutterBackground: Color {
        switch self {
        case .addition: return Color(red: 0.20, green: 0.68, blue: 0.32).opacity(0.24)
        case .deletion: return Color(red: 0.86, green: 0.20, blue: 0.20).opacity(0.24)
        case .context: return Color(.secondarySystemBackground)
        }
    }
}
