import Foundation

/// Shared `multipart/form-data` body builders for the upload and transcribe
/// endpoints. Kept in one place so `APIClient+Upload` and `APIClient+Transcribe`
/// emit byte-identical field encodings (boundaries, CRLFs, dispositions).
extension Data {
    mutating func appendMultipart(textField name: String, value: String, boundary: String) {
        append(Data("--\(boundary)\r\n".utf8))
        append(Data("Content-Disposition: form-data; name=\"\(name.multipartDispositionValue)\"\r\n\r\n".utf8))
        append(Data("\(value)\r\n".utf8))
    }

    mutating func appendMultipart(fileField name: String, filename: String, data: Data, boundary: String) {
        append(Data("--\(boundary)\r\n".utf8))
        append(Data("Content-Disposition: form-data; name=\"\(name.multipartDispositionValue)\"; filename=\"\(filename.multipartDispositionValue)\"\r\n".utf8))
        append(Data("Content-Type: application/octet-stream\r\n\r\n".utf8))
        append(data)
        append(Data("\r\n".utf8))
    }

    mutating func appendMultipartClosingBoundary(_ boundary: String) {
        append(Data("--\(boundary)--\r\n".utf8))
    }
}

private extension String {
    var multipartDispositionValue: String {
        replacingOccurrences(of: "%", with: "%25")
            .replacingOccurrences(of: "\\", with: "%5C")
            .replacingOccurrences(of: "\"", with: "%22")
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
    }
}
