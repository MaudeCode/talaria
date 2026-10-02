import SwiftUI
import TalariaKit

struct TasksView: View {
    let server: URL
    let onAPIError: (Error) -> Void

    @State private var viewModel: TasksViewModel
    @State private var showsLoading = false
    @State private var isPresentingCreateTask = false

    init(server: URL, onAPIError: @escaping (Error) -> Void) {
        self.server = server
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: TasksViewModel(server: server, responseCache: .app(server: server)))
    }

    var body: some View {
        content
            .navigationTitle("Tasks")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        viewModel.clearActionError()
                        isPresentingCreateTask = true
                    } label: {
                        Label("New Task", systemImage: "plus")
                    }
                    .disabled(viewModel.isMutating)

                    Button {
                        Task { await loadTasks() }
                    } label: {
                        if showsLoading {
                            ProgressView()
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .sheet(isPresented: $isPresentingCreateTask) {
                CronJobEditorSheet(
                    title: String(localized: "New Task"),
                    client: viewModel.client,
                    draft: CronJobEditorDraft(),
                    saveTitle: String(localized: "Create"),
                    isSaving: viewModel.isMutating,
                    errorMessage: viewModel.actionErrorMessage,
                    deliveryOptions: viewModel.deliveryOptions
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
            .delayedStatus(viewModel.isLoading, isVisible: $showsLoading)
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
        } else if viewModel.jobs.isEmpty, viewModel.recentCompletions.isEmpty {
            ContentUnavailableView {
                Label("No Tasks", systemImage: "calendar.badge.clock")
            } description: {
                Text("Scheduled jobs from the Hermes server will appear here.")
            }
        } else {
            List {
                Section {
                    HStack {
                        Label("Running now", systemImage: "bolt.fill")
                        Spacer()
                        Text("\(viewModel.activeRunningCount)")
                            .foregroundStyle(.secondary)
                    }
                }

                if !viewModel.recentCompletions.isEmpty {
                    // One row per job (its latest run), not a run archive.
                    Section("Recent Completions") {
                        ForEach(viewModel.recentCompletions) { completion in
                            if let job = viewModel.job(for: completion) {
                                NavigationLink {
                                    detail(for: job)
                                } label: {
                                    CronCompletionRowView(completion: completion)
                                }
                            } else {
                                CronCompletionRowView(completion: completion)
                            }
                        }
                    }
                }

                Section("Scheduled Jobs") {
                    if viewModel.jobs.isEmpty {
                        // Stale completions can outlive their jobs; keep the feed visible.
                        Text("No scheduled jobs.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(viewModel.jobs) { job in
                        NavigationLink {
                            detail(for: job)
                        } label: {
                            CronJobRowView(
                                job: job,
                                runningElapsed: viewModel.runningElapsed(for: job)
                            )
                        }
                    }
                }
            }
            .refreshable {
                await loadTasks()
            }
        }
    }

    private func detail(for job: CronJob) -> some View {
        TaskDetailView(
            job: job,
            runningElapsed: viewModel.runningElapsed(for: job),
            server: server,
            onAPIError: onAPIError,
            onMutation: { mutation in
                viewModel.apply(mutation)
            }
        )
    }

    /// The feed runs beside the job list as a child of the view's own task,
    /// so leaving Tasks cancels it and jobs never wait on it.
    private func loadTasks() async {
        async let feed: Void = viewModel.loadRecentCompletions()
        await viewModel.load()

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
        await feed
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
                Text(completion.completedAt?.formatted ?? String(localized: "Not available"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            // Upstream shows every non-error status as a plain completion.
            if completion.status == "error" {
                StatusBadge(text: String(localized: "Failed"), color: .red)
            } else {
                StatusBadge(text: String(localized: "Completed"), color: .green)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
