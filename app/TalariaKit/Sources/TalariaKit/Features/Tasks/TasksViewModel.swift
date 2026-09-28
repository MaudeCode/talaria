import Foundation
import Observation

public enum CronJobListMutation: Equatable {
    case upsert(CronJob)
    case delete(jobID: String)
}

@MainActor
@Observable
public final class TasksViewModel {
    public private(set) var jobs: [CronJob] = []
    private(set) var runningJobs: [String: Double] = [:]
    /// Server-provided deliver targets; `nil` while unknown or when the
    /// endpoint is unavailable (the editor then falls back to free text).
    public private(set) var deliveryOptions: [CronDeliveryOption]?
    public private(set) var isLoading = false
    public private(set) var isMutating = false
    public private(set) var errorMessage: String?
    public private(set) var actionErrorMessage: String?
    public private(set) var lastError: Error?

    /// Shared with the task editor so its catalog loads use the same scope.
    public let client: APIClient

    public init(server: URL, client: APIClient? = nil) {
        self.client = client ?? APIClient(baseURL: server)
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        lastError = nil
        defer { isLoading = false }

        do {
            async let jobsResponse = client.crons()
            async let statusResponse = client.cronStatus()
            // Optional endpoint: failure must not break the task list, and a
            // nil result keeps the editor's free-text deliver fallback.
            async let deliveryOptionsResponse = try? client.cronDeliveryOptions()

            let (jobsResult, statusResult) = try await (jobsResponse, statusResponse)
            runningJobs = statusResult.runningJobs ?? [:]
            jobs = (jobsResult.jobs ?? []).sorted(by: sortJobs)
            deliveryOptions = await deliveryOptionsResponse?.platforms
        } catch {
            lastError = error
            errorMessage = error.localizedDescription
        }
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
        jobs.sort(by: sortJobs)
    }

    private func sortJobs(_ left: CronJob, _ right: CronJob) -> Bool {
        if runningElapsed(for: left) != nil, runningElapsed(for: right) == nil {
            return true
        }

        if runningElapsed(for: left) == nil, runningElapsed(for: right) != nil {
            return false
        }

        switch (left.nextRunAt?.date, right.nextRunAt?.date) {
        case let (leftDate?, rightDate?):
            return leftDate < rightDate
        case (.some, nil):
            return true
        case (nil, .some):
            return false
        case (nil, nil):
            return left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
        }
    }
}
