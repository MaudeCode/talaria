import Foundation
import Observation

@MainActor
@Observable
public final class TaskDetailViewModel {
    public private(set) var job: CronJob
    public private(set) var runningElapsed: Double?

    public private(set) var outputs: [CronOutputItem] = []
    /// Server-provided deliver targets; `nil` while unknown or when the
    /// endpoint is unavailable (the editor then falls back to free text).
    public private(set) var deliveryOptions: [CronDeliveryOption]?
    public private(set) var isLoading = false
    public private(set) var isMutating = false
    public private(set) var errorMessage: String?
    public private(set) var actionErrorMessage: String?
    public private(set) var lastError: Error?
    public private(set) var lastMutation: CronJobListMutation?

    /// Newest-first run history, paged through `GET /api/crons/history`.
    public private(set) var runs: [CronRunSummary] = []
    public private(set) var runsTotal: Int?
    public private(set) var hasMoreRuns = false
    public private(set) var isLoadingRuns = false
    public private(set) var runsErrorMessage: String?
    /// False once the server answers 404: older servers keep recent output only.
    public private(set) var isHistorySupported = true
    public private(set) var selectedRun: CronRunSummary?
    public private(set) var selectedRunDetail: CronRunDetailResponse?
    public private(set) var isLoadingRunDetail = false
    public private(set) var runDetailErrorMessage: String?

    static let historyPageSize = 20
    private var runsOffset = 0
    private var historyGeneration = 0
    private var runDetailGeneration = 0

    /// Shared with the task editor so its catalog loads use the same scope.
    public let client: APIClient

    public init(job: CronJob, runningElapsed: Double?, server: URL, client: APIClient? = nil) {
        self.job = job
        self.runningElapsed = runningElapsed
        self.client = client ?? APIClient(baseURL: server)
    }

    public func load() async {
        guard let jobID = job.jobId else {
            errorMessage = String(localized: "Missing job identifier.")
            return
        }

        isLoading = true
        errorMessage = nil
        lastError = nil
        defer { isLoading = false }

        // Optional endpoint: failure must not break the detail view, and a
        // nil result keeps the editor's free-text deliver fallback.
        async let deliveryOptionsResponse = try? client.cronDeliveryOptions()
        // History has its own error state so a failure leaves recent output usable.
        dismissRun()
        async let history: Void = loadRunHistory(reset: true)

        do {
            let response = try await client.cronOutput(jobID: jobID, limit: 5)
            outputs = response.outputs ?? []
        } catch {
            lastError = error
            errorMessage = error.localizedDescription
        }

        deliveryOptions = await deliveryOptionsResponse?.platforms
        await history
    }

    /// Brings the job, its running state, recent output and history current without closing a run
    /// the user opened (TAL-435): the screen calls it on foreground return, cron events and its poll.
    public func refresh() async {
        guard let jobID = job.jobId else { return }
        async let statusResponse = try? client.cronStatus(jobID: jobID)
        async let jobsResponse = try? client.crons()
        async let outputResponse = try? client.cronOutput(jobID: jobID, limit: 5)
        async let history: Void = loadRunHistory(reset: true)

        if let status = await statusResponse {
            runningElapsed = status.running == true ? (status.elapsed ?? runningElapsed ?? 0) : nil
        }
        if let latest = await jobsResponse?.jobs?.first(where: { $0.jobId == jobID }) {
            job = latest
        }
        if let output = await outputResponse {
            outputs = output.outputs ?? []
        }
        await history
    }

    /// Loads the first page (`reset`) or appends the next one. A reset fences
    /// every in-flight page so a refresh never interleaves stale rows.
    public func loadRunHistory(reset: Bool = false) async {
        guard isHistorySupported, let jobID = job.jobId else { return }
        if reset {
            historyGeneration += 1
            runsOffset = 0
        } else if isLoadingRuns || !hasMoreRuns {
            return
        }
        let generation = historyGeneration
        let offset = runsOffset
        isLoadingRuns = true
        runsErrorMessage = nil
        defer {
            if generation == historyGeneration { isLoadingRuns = false }
        }

        do {
            let response = try await client.cronHistory(jobID: jobID, offset: offset, limit: Self.historyPageSize)
            guard generation == historyGeneration else { return }
            let page = (response.runs ?? []).filter { $0.filename?.isEmpty == false }
            runs = offset == 0 ? page : runs + page
            // The server slices by offset/limit before skipping unreadable files,
            // so the cursor must advance by the requested limit, not the returned row count.
            runsOffset = offset + Self.historyPageSize
            runsTotal = response.total
            hasMoreRuns = response.total.map { runsOffset < $0 } ?? !page.isEmpty
        } catch APIError.http(let statusCode, _) where statusCode == 404 {
            guard generation == historyGeneration else { return }
            isHistorySupported = false
        } catch {
            guard generation == historyGeneration else { return }
            runsErrorMessage = error.localizedDescription
        }
    }

    /// Repeats the failed request: a failed reset leaves the cursor at zero,
    /// a failed "load more" leaves it past the loaded rows.
    public func retryRunHistory() async {
        await loadRunHistory(reset: runsOffset == 0)
    }

    /// Reads one run's full output. Selecting another run fences the earlier response.
    public func loadRunDetail(_ run: CronRunSummary) async {
        guard let jobID = job.jobId, let filename = run.filename, !filename.isEmpty else { return }
        runDetailGeneration += 1
        let generation = runDetailGeneration
        selectedRun = run
        selectedRunDetail = nil
        runDetailErrorMessage = nil
        isLoadingRunDetail = true
        defer {
            if generation == runDetailGeneration { isLoadingRunDetail = false }
        }

        do {
            let response = try await client.cronRunDetail(jobID: jobID, filename: filename)
            guard generation == runDetailGeneration else { return }
            selectedRunDetail = response
        } catch {
            guard generation == runDetailGeneration else { return }
            runDetailErrorMessage = error.localizedDescription
        }
    }

    public func dismissRun() {
        runDetailGeneration += 1
        selectedRun = nil
        selectedRunDetail = nil
        runDetailErrorMessage = nil
        isLoadingRunDetail = false
    }

    public func clearActionError() {
        actionErrorMessage = nil
    }

    public func runNow() async -> Bool {
        let success = await mutateJob { jobID in
            try await client.runCron(jobID: jobID)
        }
        if success {
            runningElapsed = 0
        }
        return success
    }

    public func pause(reason: String? = nil) async -> Bool {
        let success = await mutateJob { jobID in
            try await client.pauseCron(jobID: jobID, reason: reason)
        }
        if success {
            runningElapsed = nil
        }
        return success
    }

    public func resume() async -> Bool {
        return await mutateJob { jobID in
            try await client.resumeCron(jobID: jobID)
        }
    }

    public func update(from draft: CronJobEditorDraft) async -> Bool {
        guard draft.validationMessage == nil else {
            actionErrorMessage = draft.validationMessage
            return false
        }

        return await mutateJob { jobID in
            try await client.updateCron(
                jobID: jobID,
                prompt: draft.trimmedPrompt,
                schedule: draft.trimmedSchedule,
                name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
                deliver: draft.deliver.trimmingCharacters(in: .whitespacesAndNewlines),
                skills: draft.skills,
                model: draft.model.trimmingCharacters(in: .whitespacesAndNewlines),
                provider: draft.provider.trimmingCharacters(in: .whitespacesAndNewlines),
                profile: draft.profile.trimmingCharacters(in: .whitespacesAndNewlines),
                toastNotifications: draft.toastNotifications
            )
        }
    }

    public func delete() async -> Bool {
        guard let jobID = job.jobId else {
            actionErrorMessage = String(localized: "Missing job identifier.")
            return false
        }

        isMutating = true
        actionErrorMessage = nil
        lastError = nil
        lastMutation = nil
        defer { isMutating = false }

        do {
            let response = try await client.deleteCron(jobID: jobID)
            guard response.ok != false else {
                actionErrorMessage = response.error ?? String(localized: "Could not delete task.")
                return false
            }

            lastMutation = .delete(jobID: jobID)
            return true
        } catch {
            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    private func mutateJob(
        action: (String) async throws -> CronMutationResponse
    ) async -> Bool {
        guard let jobID = job.jobId else {
            actionErrorMessage = String(localized: "Missing job identifier.")
            return false
        }

        isMutating = true
        actionErrorMessage = nil
        lastError = nil
        lastMutation = nil
        defer { isMutating = false }

        do {
            let response = try await action(jobID)
            guard response.ok != false else {
                actionErrorMessage = response.error ?? String(localized: "Could not update task.")
                return false
            }

            if let updatedJob = response.job {
                job = updatedJob
                lastMutation = .upsert(updatedJob)
            }
            return true
        } catch {
            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }
}
