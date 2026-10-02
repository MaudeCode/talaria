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
        _viewModel = State(initialValue: TasksViewModel(server: server, responseCache: ResponseCache(server: server)))
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
        } else if viewModel.jobs.isEmpty {
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

                Section("Scheduled Jobs") {
                    ForEach(viewModel.jobs) { job in
                        NavigationLink {
                            TaskDetailView(
                                job: job,
                                runningElapsed: viewModel.runningElapsed(for: job),
                                server: server,
                                onAPIError: onAPIError,
                                onMutation: { mutation in
                                    viewModel.apply(mutation)
                                }
                            )
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

    private func loadTasks() async {
        await viewModel.load()

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}
