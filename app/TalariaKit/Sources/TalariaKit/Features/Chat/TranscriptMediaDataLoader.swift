import Foundation

extension APIClient {
    /// A delivered report's folder-scoped grant, served under this server's base path.
    public nonisolated func transcriptHTMLPreviewURL(for reference: TranscriptMediaReference) -> URL? {
        guard reference.mediaKind == .html, let source = reference.previewURL,
              let path = URLComponents(string: source), path.scheme == nil, path.host == nil,
              path.query == nil, path.fragment == nil else { return nil }
        let parts = path.path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "workspace-preview",
              parts.dropFirst().allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") && !$0.contains("\\") })
        else { return nil }
        return transcriptMediaURL(for: source)
    }

    /// A transcript media item's bytes (TAL-186): a server URL loads from this server with its credentials, a remote
    /// one from its host.
    func transcriptMediaData(for reference: TranscriptMediaReference) async throws -> Data {
        guard let url = transcriptMediaURL(for: reference.url) else { throw URLError(.badURL) }
        return try await remoteTranscriptMediaData(from: url)
    }

    /// The server's media URL as a loadable URL: a remote `http(s)` URL as sent, or a server-root-relative one
    /// (`./api/media?…`) under this server's base URL, which may carry a path.
    nonisolated func transcriptMediaURL(for url: String) -> URL? {
        if let absolute = URL(string: url), let scheme = absolute.scheme?.lowercased() {
            return scheme == "http" || scheme == "https" ? absolute : nil
        }
        guard let relative = URLComponents(string: url) else { return nil }
        let path = relative.path.replacingOccurrences(of: #"^\.?/+"#, with: "", options: .regularExpression)
        guard !path.isEmpty,
              var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        else { return nil }
        components.percentEncodedQuery = relative.percentEncodedQuery
        return components.url
    }
}
