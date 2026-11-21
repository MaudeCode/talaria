import Foundation

extension APIClient {
    public func skills() async throws -> SkillsResponse {
        try await send(endpoint: .skills(query: nil), method: "GET")
    }

    /// With `query`, the server answers only the skills matching it (TAL-2528).
    public func skills(query: String? = nil, caching cache: ResponseCache.Entry?) async throws -> SkillsResponse {
        try await send(endpoint: .skills(query: query), caching: cache)
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

