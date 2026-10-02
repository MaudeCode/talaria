import Foundation

extension APIClient {
    public func crons() async throws -> CronJobsResponse {
        try await send(endpoint: .crons, method: "GET")
    }

    public func crons(caching cache: ResponseCache.Entry?) async throws -> CronJobsResponse {
        try await send(endpoint: .crons, caching: cache)
    }

    public func createCron(
        prompt: String,
        schedule: String,
        name: String?,
        deliver: String?,
        skills: [String],
        model: String?,
        provider: String?,
        profile: String?,
        toastNotifications: Bool
    ) async throws -> CronMutationResponse {
        try await send(
            endpoint: .cronCreate,
            method: "POST",
            body: CronCreateRequest(
                prompt: prompt,
                schedule: schedule,
                name: name,
                deliver: deliver,
                skills: skills,
                model: model,
                provider: provider,
                profile: profile,
                toastNotifications: toastNotifications
            )
        )
    }

    public func updateCron(
        jobID: String,
        prompt: String?,
        schedule: String?,
        name: String?,
        deliver: String?,
        skills: [String]?,
        model: String?,
        provider: String?,
        profile: String?,
        toastNotifications: Bool?
    ) async throws -> CronMutationResponse {
        try await send(
            endpoint: .cronUpdate,
            method: "POST",
            body: CronUpdateRequest(
                jobId: jobID,
                prompt: prompt,
                schedule: schedule,
                name: name,
                deliver: deliver,
                skills: skills,
                model: model,
                provider: provider,
                profile: profile,
                toastNotifications: toastNotifications
            )
        )
    }

    public func cronDeliveryOptions() async throws -> CronDeliveryOptionsResponse {
        try await send(endpoint: .cronDeliveryOptions, method: "GET")
    }

    public func deleteCron(jobID: String) async throws -> CronMutationResponse {
        try await send(
            endpoint: .cronDelete,
            method: "POST",
            body: CronJobIDRequest(jobId: jobID, reason: nil)
        )
    }

    public func runCron(jobID: String) async throws -> CronMutationResponse {
        try await send(
            endpoint: .cronRun,
            method: "POST",
            body: CronJobIDRequest(jobId: jobID, reason: nil)
        )
    }

    public func pauseCron(jobID: String, reason: String? = nil) async throws -> CronMutationResponse {
        try await send(
            endpoint: .cronPause,
            method: "POST",
            body: CronJobIDRequest(jobId: jobID, reason: reason)
        )
    }

    public func resumeCron(jobID: String) async throws -> CronMutationResponse {
        try await send(
            endpoint: .cronResume,
            method: "POST",
            body: CronJobIDRequest(jobId: jobID, reason: nil)
        )
    }

    public func cronStatus(jobID: String? = nil) async throws -> CronStatusResponse {
        try await send(endpoint: .cronStatus(jobID: jobID), method: "GET")
    }

    public func cronOutput(jobID: String, limit: Int? = 5) async throws -> CronOutputResponse {
        try await send(endpoint: .cronOutput(jobID: jobID, limit: limit), method: "GET")
    }

    public func cronHistory(jobID: String, offset: Int, limit: Int) async throws -> CronHistoryResponse {
        try await send(endpoint: .cronHistory(jobID: jobID, offset: offset, limit: limit), method: "GET")
    }

    public func cronRunDetail(jobID: String, filename: String) async throws -> CronRunDetailResponse {
        try await send(endpoint: .cronRunDetail(jobID: jobID, filename: filename), method: "GET")
    }
}

private struct CronCreateRequest: Encodable {
    let prompt: String
    let schedule: String
    let name: String?
    let deliver: String?
    let skills: [String]
    let model: String?
    let provider: String?
    let profile: String?
    let toastNotifications: Bool
}

private struct CronUpdateRequest: Encodable {
    let jobId: String
    let prompt: String?
    let schedule: String?
    let name: String?
    let deliver: String?
    let skills: [String]?
    let model: String?
    let provider: String?
    let profile: String?
    let toastNotifications: Bool?
}

private struct CronJobIDRequest: Encodable {
    let jobId: String
    let reason: String?
}

