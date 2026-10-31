import Foundation

extension APIClient {
    public func feedbackDiagnostics() async throws -> FeedbackDiagnostics {
        try await send(endpoint: .feedbackDiagnostics, method: "GET")
    }

    public func feedbackOptions() async throws -> FeedbackOptions {
        try await send(endpoint: .feedbackOptions, method: "GET")
    }

    /// Stages one compressed file; its `attachmentId` is then referenced from `submitFeedback`.
    public func uploadFeedbackAttachment(_ data: Data, contentType: String, filename: String) async throws -> FeedbackAttachmentStaged {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        body.appendMultipart(textField: "contentType", value: contentType, boundary: boundary)
        body.appendMultipart(fileField: "file", filename: filename, data: data, boundary: boundary)
        body.appendMultipartClosingBoundary(boundary)
        let (response, _) = try await sendDataReturningResponse(endpoint: .feedbackAttachments, method: "POST", encodedBody: body,
                                                                contentType: "multipart/form-data; boundary=\(boundary)")
        return try decode(FeedbackAttachmentStaged.self, from: response)
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
    public let attachments: [FeedbackAttachmentResult]

    public init(status: String, reportId: String, attachments: [FeedbackAttachmentResult] = []) {
        self.status = status; self.reportId = reportId; self.attachments = attachments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        reportId = try container.decode(String.self, forKey: .reportId)
        attachments = (try? container.decodeIfPresent([FeedbackAttachmentResult].self, forKey: .attachments)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case status, reportId, attachments }
}

/// The server's verdict for one attachment of a sent report; `reason` is set when `status` is `refused`.
public struct FeedbackAttachmentResult: Decodable, Equatable, Sendable {
    public let attachmentId: UUID
    public let status: String
    public let reason: String?

    public init(attachmentId: UUID, status: String, reason: String? = nil) {
        self.attachmentId = attachmentId; self.status = status; self.reason = reason
    }
}

/// `GET /api/feedback/options`: what this server lets its clients attach.
public struct FeedbackOptions: Decodable, Equatable, Sendable {
    public let attachments: Attachments

    public struct Attachments: Decodable, Equatable, Sendable {
        public let enabled: Bool
        public let videoAllowed: Bool
        public let maxCount: Int
        public let maxImageBytes: Int
        public let maxVideoBytes: Int
        public let maxVideoSeconds: Int
        public let acceptedTypes: [String]

        public init(enabled: Bool, videoAllowed: Bool, maxCount: Int, maxImageBytes: Int, maxVideoBytes: Int,
                    maxVideoSeconds: Int, acceptedTypes: [String]) {
            self.enabled = enabled; self.videoAllowed = videoAllowed; self.maxCount = maxCount
            self.maxImageBytes = maxImageBytes; self.maxVideoBytes = maxVideoBytes
            self.maxVideoSeconds = maxVideoSeconds; self.acceptedTypes = acceptedTypes
        }
    }

    public init(attachments: Attachments) { self.attachments = attachments }
}

/// One file staged by `POST /api/feedback/attachments`.
public struct FeedbackAttachmentStaged: Decodable, Equatable, Sendable {
    public let attachmentId: UUID
    public let contentType: String
    public let bytes: Int

    public init(attachmentId: UUID, contentType: String, bytes: Int) {
        self.attachmentId = attachmentId; self.contentType = contentType; self.bytes = bytes
    }
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
    /// Stamped with `client` when sending; omitted when empty because the contract requires at least one ID.
    public var attachmentIds: [UUID]?

    public init(requestId: UUID = UUID(), kind: String = "bug", title: String = "", body: String = "",
                includeDiagnostics: Bool = true, client: FeedbackClient? = nil, attachmentIds: [UUID]? = nil) {
        self.requestId = requestId
        self.kind = kind
        self.title = title
        self.body = body
        self.includeDiagnostics = includeDiagnostics
        self.client = client
        self.attachmentIds = attachmentIds
    }
}
