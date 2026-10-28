import Foundation

extension APIClient {
    public func feedbackDiagnostics() async throws -> FeedbackDiagnostics {
        try await send(endpoint: .feedbackDiagnostics, method: "GET")
    }

    public func submitFeedback(_ request: FeedbackRequest) async throws -> FeedbackResult {
        // This contract uses camelCase; the client's legacy encoder converts keys to snake_case.
        let data = try await sendData(endpoint: .feedbackSubmit, method: "POST", encodedBody: JSONEncoder().encode(request))
        return try decode(FeedbackResult.self, from: data)
    }
}

public struct FeedbackDiagnostics: Decodable, Sendable {
    public let text: String
    public let bytes: Int

    public init(text: String, bytes: Int) { self.text = text; self.bytes = bytes }
}

public struct FeedbackResult: Decodable, Sendable {
    public let status: String
    public let reportId: String

    public init(status: String, reportId: String) { self.status = status; self.reportId = reportId }
}

public struct FeedbackClient: Codable, Equatable, Sendable {
    public var platform = "ios"
    public let appVersion: String
    public let osVersion: String
    public let deviceModel: String

    public init(appVersion: String, osVersion: String, deviceModel: String) {
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.deviceModel = deviceModel
    }
}

/// The same envelope is persisted before sending, including the platform stamp, for idempotent retries.
public struct FeedbackRequest: Codable, Equatable, Sendable {
    public var requestId = UUID()
    public var kind = "bug"
    public var title = ""
    public var body = ""
    public var includeDiagnostics = true
    public var client: FeedbackClient?

    public init(requestId: UUID = UUID(), kind: String = "bug", title: String = "", body: String = "",
                includeDiagnostics: Bool = true, client: FeedbackClient? = nil) {
        self.requestId = requestId
        self.kind = kind
        self.title = title
        self.body = body
        self.includeDiagnostics = includeDiagnostics
        self.client = client
    }
}
