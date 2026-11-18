import Foundation

extension APIClient {
    /// Asks the server to load its speech-to-text engine while a recording is still
    /// in progress, so a cold local model does not eat the upload's transcription
    /// timeout. Sent only when the capability's `warm_supported` says so. Best
    /// effort: the server answers at once and every failure is ignored.
    func warmTranscriptionIfSupported() async {
        guard let capability: TranscribeCapability = try? await send(endpoint: .transcribeCapability, method: "GET"),
              capability.warmSupported == true
        else { return }
        _ = try? await sendData(endpoint: .transcribeWarm, method: "POST", body: EmptyBody())
    }

    /// Uploads an audio clip to the server's speech-to-text endpoint and returns
    /// the tolerant `{ok, transcript, error}` payload: `uploadFile`'s multipart
    /// shape with only the `file` field (no `session_id`).
    ///
    /// The server returns a JSON `{error: ...}` body even for 503/400/413
    /// responses, so we decode the body regardless of status and let the caller
    /// inspect `.error`. Only `401` maps to `.unauthorized`; a body that isn't the
    /// expected shape on a non-2xx status surfaces as `.http`.
    public func transcribeAudio(data: Data, filename: String) async throws -> TranscribeResponse {
        let (responseData, httpResponse) = try await sendMultipart(endpoint: .transcribe, filename: filename, data: data)
        // Decode first: the server returns `{error: ...}` even for 503/400/413, so
        // surfacing `.error` is friendlier than a raw HTTP failure. Fall back to a
        // thrown HTTP error only when the body isn't the expected JSON shape.
        if let decoded = try? decode(TranscribeResponse.self, from: responseData) {
            return decoded
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw APIError.http(
                statusCode: httpResponse.statusCode,
                body: String(data: responseData, encoding: .utf8)
            )
        }
        return try decode(TranscribeResponse.self, from: responseData)
    }
}
