import Foundation

extension APIClient {
    public func skills() async throws -> SkillsResponse {
        try await send(endpoint: .skills, method: "GET")
    }

    public func skills(caching cache: ResponseCache.Entry?) async throws -> SkillsResponse {
        try await send(endpoint: .skills, caching: cache)
    }

    public func skillContent(name: String, file: String? = nil) async throws -> SkillDetailResponse {
        try await send(endpoint: .skillContent(name: name, file: file), method: "GET")
    }

    public func toggleSkill(name: String, enabled: Bool) async throws -> ToggleSkillResponse {
        try await send(
            endpoint: .toggleSkill,
            method: "POST",
            body: ToggleSkillRequest(name: name, enabled: enabled)
        )
    }
}

