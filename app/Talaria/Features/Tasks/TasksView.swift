import SwiftUI
import TalariaKit

/// The job list. A row selects its job, which `TaskDetailView` shows beside the list or pushed
/// over it (TAL-643).
struct TasksView: View {
    let viewModel: TasksViewModel
    @Binding var selection: SectionItem?
    let onAPIError: (Error) -> Void

    @State private var isPresentingCreateTask = false

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

                    RefreshToolbarButton(isLoading: viewModel.isLoading) {
                        Task { await loadTasks() }
                    }
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
                                SectionSelectionRow(item: .task(id: job.id), selection: $selection) {
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
                        SectionSelectionRow(item: .task(id: job.id), selection: $selection) {
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
