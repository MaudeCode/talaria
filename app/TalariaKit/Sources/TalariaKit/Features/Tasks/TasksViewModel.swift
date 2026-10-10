import Foundation
import Observation

public enum CronJobListMutation: Equatable {
    case upsert(CronJob)
    case delete(jobID: String)
}

@MainActor
@Observable
public final class TasksViewModel {
    private var loadGeneration = 0
    public private(set) var jobs: [CronJob] = []
    private(set) var runningJobs: [String: Double] = [:]
    /// Server-provided deliver targets; `nil` while unknown or when the
    /// endpoint is unavailable (the editor then falls back to free text).
    public private(set) var deliveryOptions: [CronDeliveryOption]?
    /// Each job's latest completion in server order. The view loads it beside
    /// `load()` so an older server or a feed failure never blocks jobs, and a
    /// failed reload keeps the last good feed.
    public private(set) var recentCompletions: [CronRecentCompletion] = []
    public private(set) var isLoading = false
    public private(set) var isMutating = false
    public private(set) var errorMessage: String?
    public private(set) var actionErrorMessage: String?
    public private(set) var lastError: Error?

    private var recentCompletionsGeneration = 0

    /// Shared with the task editor so its catalog loads use the same scope.
    public let client: APIClient
    private let responseCache: ResponseCache?

    public init(server: URL, client: APIClient? = nil, responseCache: ResponseCache? = nil) {
        self.client = client ?? APIClient(baseURL: server)
        self.responseCache = responseCache
        // The last jobs show at once (TAL-437); running state is never cached, it goes stale too fast.
        if let cached = responseCache?.entry(ResponseCache.Kind.crons).load(CronJobsResponse.self) {
            jobs = cached.jobs ?? []
        }
    }

    public func load() async {
        // The view model outlives its screen (TAL-643): a rebuilt screen starts a new load while
        // the old one may still be in flight, so only the latest load updates the model.
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        lastError = nil
        defer {
            if generation == loadGeneration { isLoading = false }
        }

        do {
            async let jobsResponse = client.crons(caching: responseCache?.entry(ResponseCache.Kind.crons))
            async let statusResponse = client.cronStatus()
            // Optional endpoint: failure must not break the task list, and a
            // nil result keeps the editor's free-text deliver fallback.
            async let deliveryOptionsResponse = try? client.cronDeliveryOptions()

            let (jobsResult, statusResult) = try await (jobsResponse, statusResponse)
            let deliveryOptions = await deliveryOptionsResponse?.platforms
            guard generation == loadGeneration else { return }
            runningJobs = statusResult.runningJobs ?? [:]
            // The server owns the list order (TAL-601).
            jobs = jobsResult.jobs ?? []
            self.deliveryOptions = deliveryOptions
        } catch {
            guard generation == loadGeneration, !APIError.isCancellation(error) else { return }
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    /// A reload fences every in-flight feed request so a slow earlier response
    /// cannot overwrite a newer one. Rows keep the server's order.
    public func loadRecentCompletions() async {
        recentCompletionsGeneration += 1
        let generation = recentCompletionsGeneration
        guard let response = try? await client.cronRecentCompletions(),
              generation == recentCompletionsGeneration else { return }
        recentCompletions = response.completions ?? []
    }

    /// The job a completion row opens, by job ID only. `nil` leaves the row
    /// without navigation.
    public func job(for completion: CronRecentCompletion) -> CronJob? {
        jobs.first { $0.jobId == completion.jobId }
    }

    public func runningElapsed(for job: CronJob) -> Double? {
        guard let jobID = job.jobId else { return nil }
        return runningJobs[jobID]
    }

    public func clearActionError() {
        actionErrorMessage = nil
    }

    public func create(from draft: CronJobEditorDraft) async -> Bool {
        guard draft.validationMessage == nil else {
            actionErrorMessage = draft.validationMessage
            return false
        }

        isMutating = true
        actionErrorMessage = nil
        lastError = nil
        defer { isMutating = false }

        do {
            let response = try await client.createCron(
                prompt: draft.trimmedPrompt,
                schedule: draft.trimmedSchedule,
                name: draft.trimmedName,
                deliver: draft.trimmedDeliver,
                skills: draft.skills,
                model: draft.trimmedModel,
                provider: draft.trimmedProvider,
                profile: draft.trimmedProfile,
                toastNotifications: draft.toastNotifications
            )

            guard response.ok != false else {
                actionErrorMessage = response.error ?? String(localized: "Could not create task.")
                return false
            }

            if let job = response.job {
                apply(.upsert(job))
            } else {
                await load()
            }
            return true
        } catch {
            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    public func apply(_ mutation: CronJobListMutation) {
        switch mutation {
        case .upsert(let job):
            upsert(job)
        case .delete(let jobID):
            jobs.removeAll { $0.jobId == jobID }
            runningJobs.removeValue(forKey: jobID)
        }
    }

    public var activeRunningCount: Int {
        runningJobs.count
    }

    private func upsert(_ job: CronJob) {
        let matchingIndex: Int?
        if let jobID = job.jobId {
            matchingIndex = jobs.firstIndex { $0.jobId == jobID }
        } else if let name = job.name {
            matchingIndex = jobs.firstIndex { $0.jobId == nil && $0.name == name }
        } else {
            matchingIndex = nil
        }

        if let index = matchingIndex {
            jobs[index] = job
        } else {
            jobs.append(job)
        }
    }
}
