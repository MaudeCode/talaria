import Foundation

extension APIClient {
    public func memory() async throws -> MemoryResponse {
        try await send(endpoint: .memory, method: "GET")
    }

    public func memory(caching cache: ResponseCache.Entry?) async throws -> MemoryResponse {
        try await send(endpoint: .memory, caching: cache)
    }

    public func writeMemory(section: MemorySection, content: String) async throws -> MemoryWriteResponse {
        try await send(
            endpoint: .memoryWrite,
            method: "POST",
            body: MemoryWriteRequest(section: section, content: content)
        )
    }
}

private struct MemoryWriteRequest: Encodable {
    let section: MemorySection
    let content: String
}

