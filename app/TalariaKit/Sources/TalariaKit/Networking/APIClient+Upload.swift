import Foundation

extension APIClient {
    public func uploadFile(sessionID: String, data: Data, filename: String) async throws -> UploadResponse {
        let (responseData, httpResponse) = try await sendMultipart(
            endpoint: .upload, textFields: [("session_id", sessionID)], filename: filename, data: data
        )
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw APIError.http(
                statusCode: httpResponse.statusCode,
                body: String(data: responseData, encoding: .utf8)
            )
        }
        return try decode(UploadResponse.self, from: responseData)
    }

    /// One multipart POST whose `file` field carries `data` (upload, transcribe). Unlike `sendDataReturningResponse`
    /// it sets no Accept header, keeps a transport failure as the raw `URLError`, and returns a non-2xx answer for the
    /// caller to judge; only `401` maps to `.unauthorized`.
    func sendMultipart(
        endpoint: Endpoint,
        textFields: [(name: String, value: String)] = [],
        filename: String,
        data: Data
    ) async throws -> (Data, HTTPURLResponse) {
        try requireMutationAuthorization()
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: endpoint.url(relativeTo: baseURL))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Custom headers first, then built-ins so the multipart Content-Type
        // always wins. Without them the upload is rejected by auth reverse
        // proxies that every other request path already passes (#61).
        customHeaderProvider().apply(to: &request)
        AppConfig.applyClientIdentity(to: &request)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        for field in textFields {
            body.appendMultipart(textField: field.name, value: field.value, boundary: boundary)
        }
        body.appendMultipart(fileField: "file", filename: filename, data: data, boundary: boundary)
        body.appendMultipartClosingBoundary(boundary)
        request.httpBody = body

        let (responseData, response) = try await session.data(for: request, delegate: redirectHeaderStripper)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.http(statusCode: -1, body: nil)
        }
        if httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }
        return (responseData, httpResponse)
    }
}
