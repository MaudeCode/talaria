import SwiftUI
import TalariaKit

/// The job list. A row selects its job, which `TaskDetailView` shows beside the list or pushed
/// over it (TAL-643).
struct TasksView: View {
    let viewModel: TasksViewModel
    @Binding var selection: SectionItem?
    let onAPIError: (Error) -> Void


    var body: some View {
        content
            .navigationTitle("Tasks")
            .toolbar {
                TasksListActions(viewModel: viewModel, onAPIError: onAPIError)
            }
            .sheet(isPresented: Bindable(viewModel).isPresentingCreateTask) {
                CronJobEditorSheet(
                    title: String(localized: "New Task"),
                    client: viewModel.client,
                    draft: CronJobEditorDraft(),
                    saveTitle: String(localized: "Create"),
                    isSaving: viewModel.isMutating,
                    errorMessage: viewModel.actionErrorMessage,
                    deliveryOptions: viewModel.deliveryOptions,
                    allowsBlueprints: true
                ) { draft in
                    let didCreate = await viewModel.create(from: draft)
                    if let lastError = viewModel.lastError {
                        onAPIError(lastError)
                    }
                    return didCreate
                }
            }
            .task {
                await loadTasks()
            }
            .refreshesLive(on: .cronRun, every: .seconds(30), showsStatus: false) {
                await loadTasks()
            }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.jobs.isEmpty {
            ProgressView("Loading tasks...")
        } else if let errorMessage = viewModel.errorMessage, viewModel.jobs.isEmpty {
            ContentUnavailableView {
                Label("Could Not Load Tasks", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await loadTasks() }
                }
            }
        } else if viewModel.jobs.isEmpty, viewModel.recentCompletions.isEmpty, viewModel.unwritableStores.isEmpty {
            ContentUnavailableView {
                Label("No Tasks", systemImage: "calendar.badge.clock")
            } description: {
                Text("Scheduled jobs from the Hermes server will appear here.")
            }
        } else {
            SidebarList {
                CronStoreHealthBanner(stores: viewModel.unwritableStores)
                    .sessionsScreenListRow()
                taskRows
            }
            .refreshable {
                await loadTasks()
            }
        }
    }

    /// The feed runs beside the job list as a child of the view's own task,
    /// so leaving Tasks cancels it and jobs never wait on it.
    private func loadTasks() async {
        await TasksListActions.load(viewModel, onAPIError: onAPIError)
    }
}

/// The job list's bar actions: in its own column, or in the detail column beside the iPhone Duo's vertical bar
/// (TAL-1528).
struct TasksListActions: ToolbarContent {
    let viewModel: TasksViewModel
    let onAPIError: (Error) -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                viewModel.clearActionError()
                viewModel.isPresentingCreateTask = true
            } label: {
                Label("New Task", systemImage: "plus")
            }
            .disabled(viewModel.isMutating)
        }
        .overflowPriority(.create)

        ToolbarItem(placement: .topBarTrailing) {
            RefreshToolbarButton(isLoading: viewModel.isLoading) {
                Task { await Self.load(viewModel, onAPIError: onAPIError) }
            }
        }
    }

    @MainActor
    static func load(_ viewModel: TasksViewModel, onAPIError: (Error) -> Void) async {
        async let feed: Void = viewModel.loadRecentCompletions()
        await viewModel.load()

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
        await feed
    }
}

/// Where the Tasks list remembers which of its sections are collapsed.
enum TaskSidebarDisclosureSettings {
    static let recentCompletionsAreExpandedKey = "tasksSidebar.recentCompletionsAreExpanded"
    static let scheduledJobsAreExpandedKey = "tasksSidebar.scheduledJobsAreExpanded"
}

private extension TasksView {
    /// Recent completions and scheduled jobs with the running count.
    @ViewBuilder
    var taskRows: some View {
        if !viewModel.recentCompletions.isEmpty {
            // One row per job (its latest run), not a run archive.
            SidebarDisclosureSection(
                String(localized: "Recent Completions"),
                storageKey: TaskSidebarDisclosureSettings.recentCompletionsAreExpandedKey
            ) {
                ForEach(viewModel.recentCompletions) { completion in
                    if let job = viewModel.job(for: completion) {
                        SectionSelectionRow(item: .task(id: job.id), selection: $selection) {
                            CronCompletionRowView(completion: completion)
                        }
                    } else {
                        CronCompletionRowView(completion: completion)
                            .sidebarRowPadding()
                            .sidebarRow(isSelected: false)
                    }
                }
            }
        }

        SidebarDisclosureSection(
            String(localized: "Scheduled Jobs"),
            storageKey: TaskSidebarDisclosureSettings.scheduledJobsAreExpandedKey
        ) {
            Label("\(viewModel.activeRunningCount) running", systemImage: "bolt.fill")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } content: {
            if viewModel.jobs.isEmpty {
                // Stale completions can outlive their jobs; keep the feed visible.
                Text("No scheduled jobs.")
                    .foregroundStyle(.secondary)
                    .sidebarRowPadding()
                    .sidebarRow(isSelected: false)
            }
            ForEach(viewModel.jobs) { job in
                SectionSelectionRow(item: .task(id: job.id), selection: $selection) {
                    CronJobRowView(
                        job: job,
                        isRunning: viewModel.isRunning(job),
                        runningElapsed: viewModel.runningElapsed(for: job)
                    )
                }
            }
        }
    }
}

/// The server's unwritable cron stores (TAL-810): their schedulers skip every run until the store is writable again.
/// A healthy list shows nothing.
struct CronStoreHealthBanner: View {
    let stores: [CronStoreHealth]

    var body: some View {
        if !stores.isEmpty {
            SessionListBanner(
                systemImage: "exclamationmark.triangle",
                title: "Scheduled tasks can't run",
                detail: stores.map(Self.detail).joined(separator: "\n\n"),
                detailLineLimit: nil
            )
        }
    }

    private static func detail(_ store: CronStoreHealth) -> String {
        let since = store.since.map { String(localized: "Last saved \($0.formatted(date: .abbreviated, time: .shortened))") }
        return [
            [store.profile, store.error].compactMap { $0 }.joined(separator: ": "),
            store.fix,
            since,
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    }
}

private struct CronCompletionRowView: View {
    let completion: CronRecentCompletion

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(completion.displayName)
                    .font(.headline)
                    .lineLimit(2)
                Text(completion.completedAt?.formatted(date: .abbreviated, time: .shortened) ?? String(localized: "Not available"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            switch completion.outcome {
            case .succeeded:
                StatusBadge(text: String(localized: "Completed"), color: .green)
            case .failed:
                StatusBadge(text: String(localized: "Failed"), color: .red)
            case .unknown:
                StatusBadge(text: String(localized: "Unknown"), color: .secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
