import Foundation

/// TAL-1968: `show` blocks (`/api/show/…`) and the server URLs their fields name.
extension APIClient {
    public func showBlock(id: String) async throws -> ShowBlock {
        try await send(endpoint: .showBlock(id: id), method: "GET")
    }

    /// A block field's server-root-relative URL (an HTML block's `frame_url`) under this server's base URL.
    public nonisolated func showBlockURL(_ relative: String) -> URL? {
        transcriptMediaURL(for: relative)
    }
}
