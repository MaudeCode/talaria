import Foundation
import Observation
import TalariaKit

@MainActor
@Observable
final class TaskDetailViewModel {
    private(set) var job: CronJob
    private(set) var runningElapsed: Double?

    private(set) var outputs: [CronOutputItem] = []
    /// Server-provided deliver targets; `nil` while unknown or when the
    /// endpoint is unavailable (the editor then falls back to free text).
    private(set) var deliveryOptions: [CronDeliveryOption]?
    private(set) var isLoading = false
    private(set) var isMutating = false
    private(set) var errorMessage: String?
    private(set) var actionErrorMessage: String?
    private(set) var lastError: Error?
    private(set) var lastMutation: CronJobListMutation?

    /// Newest-first run history, paged through `GET /api/crons/history`.
    private(set) var runs: [CronRunSummary] = []
    private(set) var runsTotal: Int?
    private(set) var hasMoreRuns = false
    private(set) var isLoadingRuns = false
    private(set) var runsErrorMessage: String?
    /// False once the server answers 404: older servers keep recent output only.
    private(set) var isHistorySupported = true
    private(set) var selectedRun: CronRunSummary?
    private(set) var selectedRunDetail: CronRunDetailResponse?
    private(set) var isLoadingRunDetail = false
    private(set) var runDetailErrorMessage: String?

    static let historyPageSize = 20
    private var runsOffset = 0
    private var historyGeneration = 0
    private var runDetailGeneration = 0

    /// Shared with the task editor so its catalog loads use the same scope.
    let client: APIClient

    init(job: CronJob, runningElapsed: Double?, server: URL, client: APIClient? = nil) {
        self.job = job
        self.runningElapsed = runningElapsed
        self.client = client ?? APIClient(baseURL: server)
    }

    func load() async {
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

    /// Loads the first page (`reset`) or appends the next one. A reset fences
    /// every in-flight page so a refresh never interleaves stale rows.
    func loadRunHistory(reset: Bool = false) async {
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
    func retryRunHistory() async {
        await loadRunHistory(reset: runsOffset == 0)
    }

    /// Reads one run's full output. Selecting another run fences the earlier response.
    func loadRunDetail(_ run: CronRunSummary) async {
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

    func dismissRun() {
        runDetailGeneration += 1
        selectedRun = nil
        selectedRunDetail = nil
        runDetailErrorMessage = nil
        isLoadingRunDetail = false
    }

    func clearActionError() {
        actionErrorMessage = nil
    }

    func runNow() async -> Bool {
        let success = await mutateJob { jobID in
            try await client.runCron(jobID: jobID)
        }
        if success {
            runningElapsed = 0
        }
        return success
    }

    func pause(reason: String? = nil) async -> Bool {
        let success = await mutateJob { jobID in
            try await client.pauseCron(jobID: jobID, reason: reason)
        }
        if success {
            runningElapsed = nil
        }
        return success
    }

    func resume() async -> Bool {
        return await mutateJob { jobID in
            try await client.resumeCron(jobID: jobID)
        }
    }

    func update(from draft: CronJobEditorDraft) async -> Bool {
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

    func delete() async -> Bool {
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
