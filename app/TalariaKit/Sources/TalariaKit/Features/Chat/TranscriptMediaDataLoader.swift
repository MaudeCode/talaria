import Foundation

extension APIClient {
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
