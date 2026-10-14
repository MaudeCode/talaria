import Foundation

extension APIClient {
    public func memory() async throws -> MemoryResponse {
        try await send(endpoint: .memory, method: "GET")
    }

    public func memory(caching cache: ResponseCache.Entry?) async throws -> MemoryResponse {
        try await send(endpoint: .memory, caching: cache)
    }

    /// `revision` is the section's revision the edit started from; the server refuses the save when the file changed since.
    public func writeMemory(section: MemorySection, content: String, revision: String?) async throws -> MemoryWriteResponse {
        try await send(
            endpoint: .memoryWrite,
            method: "POST",
            body: MemoryWriteRequest(section: section, content: content, revision: revision)
        )
    }
}

private struct MemoryWriteRequest: Encodable {
    let section: MemorySection
    let content: String
    let revision: String?
}

