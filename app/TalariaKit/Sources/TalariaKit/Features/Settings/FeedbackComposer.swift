import Foundation
import Observation

/// A file the user added to feedback: compressed on device into the composer's staging directory, then staged on
/// the server, which returns `attachmentId`.
public struct FeedbackAttachment: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let contentType: String
    public var attachmentId: UUID?

    public init(id: UUID = UUID(), contentType: String, attachmentId: UUID? = nil) {
        self.id = id
        self.contentType = contentType
        self.attachmentId = attachmentId
    }

    var fileName: String {
        switch contentType {
        case "video/mp4": "\(id.uuidString).mp4"
        case "image/png": "\(id.uuidString).png"
        default: "\(id.uuidString).jpg"
        }
    }

    var thumbnailName: String { "\(id.uuidString).thumbnail.jpg" }
}

/// Device-local feedback draft and optimistic presentation. The server owns diagnostics and delivery.
@MainActor
@Observable
public final class FeedbackComposer {
    private static let composers = NSHashTable<FeedbackComposer>(options: [.weakMemory, .objectPointerPersonality])
    public private(set) var draft: FeedbackRequest
    public var isPresented = false
    public private(set) var error: SettingsErrorText?
    public private(set) var diagnosticsText: String?
    public private(set) var diagnosticsError: SettingsErrorText?
    public private(set) var hasUnknownOutcome: Bool
    public private(set) var isSending = false
    /// What this server accepts; nil until loaded, and attaching stays hidden unless `enabled`.
    public private(set) var attachmentOptions: FeedbackOptions.Attachments?
    public private(set) var attachments: [FeedbackAttachment]
    /// A PNG of the screen behind the sheet, offered for the user to include; never attached by default.
    public private(set) var currentScreen: Data?
    public private(set) var attachmentError: SettingsErrorText?
    public let confirmation = GitActionToastState()
    public let server: URL?
    public static let imageMaxPixelSize = 2_560
    public nonisolated static let defaultStagingRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FeedbackAttachments", isDirectory: true)

    private let defaults: UserDefaults
    private let storageKey: String
    private let cacheGeneration: Int
    private let clientMetadata: FeedbackClient
    private let submit: (FeedbackRequest) async throws -> FeedbackResult
    private let diagnostics: () async throws -> FeedbackDiagnostics
    private let loadOptions: () async throws -> FeedbackOptions
    private let uploadAttachment: (Data, String, String) async throws -> FeedbackAttachmentStaged
    /// Holds this server's compressed files with the draft that references them.
    private let stagingDirectory: URL
    private var uploadPhases: [UUID: PendingAttachment.UploadPhase] = [:]
    private var thumbnails: [UUID: Data] = [:]

    private struct Stored: Codable {
        let draft: FeedbackRequest
        let hasUnknownOutcome: Bool
        var attachments: [FeedbackAttachment]?
    }

    public init(server: URL?, defaults: UserDefaults = .standard, clientMetadata: FeedbackClient,
                stagingRoot: URL = FeedbackComposer.defaultStagingRoot,
                submit: ((FeedbackRequest) async throws -> FeedbackResult)? = nil,
                diagnostics: (() async throws -> FeedbackDiagnostics)? = nil,
                options: (() async throws -> FeedbackOptions)? = nil,
                upload: ((Data, String, String) async throws -> FeedbackAttachmentStaged)? = nil) {
        self.server = server
        self.defaults = defaults
        self.clientMetadata = clientMetadata
        storageKey = Self.storageKey(for: server)
        let stagingDirectory = Self.stagingDirectory(for: server, root: stagingRoot)
        self.stagingDirectory = stagingDirectory
        cacheGeneration = server.map { ServerCacheGeneration.current(for: $0) } ?? 0
        let stored = defaults.data(forKey: storageKey).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        draft = stored?.draft ?? FeedbackRequest()
        hasUnknownOutcome = stored?.hasUnknownOutcome ?? false
        // A file lost before it was staged cannot be sent; one compressed but not staged waits for Retry.
        attachments = (stored?.attachments ?? []).filter { attachment in
            attachment.attachmentId != nil
                || FileManager.default.fileExists(atPath: stagingDirectory.appendingPathComponent(attachment.fileName).path)
        }

        if stored?.hasUnknownOutcome == true {
            error = SettingsErrorText(String(localized: "The send could not be confirmed. Retry to check the same report."))
        }
        // Like the auth probe, keep credentials bound to the server that opened this composer.
        let headers = CustomHeaderStore.shared.snapshot()
        let client = server.map { APIClient(baseURL: $0, customHeaderProvider: { headers }) }
        self.submit = submit ?? { request in
            guard let client else { throw APIError.invalidServerURL }
            return try await client.submitFeedback(request)
        }
        self.diagnostics = diagnostics ?? {
            guard let client else { throw APIError.invalidServerURL }
            return try await client.feedbackDiagnostics()
        }
        self.loadOptions = options ?? {
            guard let client else { throw APIError.invalidServerURL }
            return try await client.feedbackOptions()
        }
        uploadAttachment = upload ?? { data, contentType, filename in
            guard let client else { throw APIError.invalidServerURL }
            return try await client.uploadFeedbackAttachment(data, contentType: contentType, filename: filename)
        }
        for attachment in attachments {
            thumbnails[attachment.id] = try? Data(contentsOf: stagingDirectory.appendingPathComponent(attachment.thumbnailName))
            if attachment.attachmentId == nil { uploadPhases[attachment.id] = .failed(String(localized: "Upload paused. Try again.")) }
        }
        Self.composers.add(self)
    }

    public var canSend: Bool {
        isCurrent && server != nil && !isSending
            && !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && validationError == nil
            && attachments.allSatisfy { $0.attachmentId != nil }
    }

    /// The server allows attachments and the form is still editable.
    public var attachmentsEnabled: Bool {
        attachmentOptions?.enabled == true && isEditable
    }

    public var videoAllowed: Bool { attachmentsEnabled && attachmentOptions?.videoAllowed == true }

    /// How many more files the server's `maxCount` lets the user add.
    public var remainingAttachmentSlots: Int {
        attachmentsEnabled ? max(0, (attachmentOptions?.maxCount ?? 0) - attachments.count) : 0
    }

    /// The attachments as the shared composer strip shows them, each with its own upload state.
    public var pendingAttachments: [PendingAttachment] {
        attachments.map { attachment in
            PendingAttachment(id: attachment.id, name: Self.displayName(for: attachment), path: attachment.attachmentId?.uuidString ?? "",
                              mime: attachment.contentType, isImage: true, thumbnailData: thumbnails[attachment.id],
                              uploadPhase: uploadPhases[attachment.id] ?? (attachment.attachmentId == nil ? .uploading : .ready))
        }
    }

    /// The Current screen offer in the same strip form, until the user includes it.
    public var currentScreenOffer: PendingAttachment? {
        guard let currentScreen, remainingAttachmentSlots > 0 else { return nil }
        return PendingAttachment(id: Self.currentScreenOfferID, name: String(localized: "Current screen"), path: "",
                                 mime: "image/png", isImage: true, thumbnailData: currentScreen)
    }

    public var validationError: SettingsErrorText? {
        if draft.title.utf16.count > 120 {
            return SettingsErrorText(String(localized: "Title must be 120 characters or fewer."))
        }
        if draft.body.utf16.count > 8000 {
            return SettingsErrorText(String(localized: "Details must be 8000 characters or fewer."))
        }
        return nil
    }

    public func edit(_ change: (inout FeedbackRequest) -> Void) {
        guard isEditable else { return }
        var edited = draft
        change(&edited)
        guard edited != draft else { return }
        draft = edited
        startNewReportIfRefused()
        persist()
    }

    public func loadAttachmentOptions() async {
        guard isCurrent else { return }
        guard let options = try? await loadOptions() else { return }
        guard isCurrent else { return }
        attachmentOptions = options.attachments
    }

    /// Records the screen behind the sheet as an offer; it is attached only through `includeCurrentScreen`.
    public func offerCurrentScreen(_ png: Data?) {
        guard isEditable else { return }
        currentScreen = png
    }

    @discardableResult
    public func includeCurrentScreen() -> Task<Void, Never>? {
        guard let png = currentScreen, remainingAttachmentSlots > 0 else { return nil }
        currentScreen = nil
        return addImage(png, isScreenCapture: true)
    }

    /// Re-encodes a picked photo (JPEG) or the screen capture (PNG) without metadata, then stages it.
    @discardableResult
    public func addImage(_ data: Data, isScreenCapture: Bool = false) -> Task<Void, Never>? {
        guard remainingAttachmentSlots > 0, let maxBytes = attachmentOptions?.maxImageBytes else { return nil }
        let attachment = FeedbackAttachment(contentType: isScreenCapture ? "image/png" : "image/jpeg")
        return add(attachment) { destination in
            guard let image = await ImagePreviewDownsampler.uploadImage(
                from: data, maxPixelSize: Self.imageMaxPixelSize, format: isScreenCapture ? .png : .jpeg, jpegQuality: 0.8
            ) else { throw FeedbackVideoEncoder.Failure.unreadable }
            guard image.data.count <= maxBytes else { throw FeedbackVideoEncoder.Failure.tooLarge }
            try image.data.write(to: destination)
            return await ImagePreviewDownsampler.previewDataAsync(from: image.data, maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize)
        }
    }

    /// Re-encodes a picked clip to the server's limits; a clip over `maxVideoSeconds` is refused inline.
    @discardableResult
    public func addVideo(at source: URL) -> Task<Void, Never>? {
        guard remainingAttachmentSlots > 0, videoAllowed, let options = attachmentOptions else { return nil }
        return add(FeedbackAttachment(contentType: "video/mp4")) { destination in
            try await FeedbackVideoEncoder.encode(source, to: destination, maxBytes: options.maxVideoBytes, maxSeconds: options.maxVideoSeconds)
            return await FeedbackVideoEncoder.thumbnail(of: destination)
        }
    }

    /// The compressed file exactly as it is sent, for the preview: the reference's `url` is that local file.
    /// Nil until compression has written it.
    public func previewReference(of id: UUID) -> TranscriptMediaReference? {
        guard let attachment = attachments.first(where: { $0.id == id }) else { return nil }
        let file = stagingDirectory.appendingPathComponent(attachment.fileName)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return TranscriptMediaReference(url: file.absoluteString, name: Self.displayName(for: attachment), mime: attachment.contentType,
                                        mediaKind: attachment.contentType.hasPrefix("video/") ? .video : .image)
    }

    public func removeAttachment(_ id: UUID) {
        guard isEditable, let attachment = attachments.first(where: { $0.id == id }) else { return }
        attachments.removeAll { $0.id == id }
        uploadPhases[id] = nil
        thumbnails[id] = nil
        deleteStagedFiles(of: attachment)
        startNewReportIfRefused()
        persist()
    }

    @discardableResult
    public func retryAttachment(_ id: UUID) -> Task<Void, Never>? {
        guard isEditable, case .failed = uploadPhases[id] else { return nil }
        return Task { await upload(id) }
    }

    public func loadDiagnostics() async {
        guard isCurrent else { return }
        diagnosticsError = nil
        do {
            let result = try await diagnostics()
            guard isCurrent else { return }
            diagnosticsText = result.text
        } catch {
            guard isCurrent else { return }
            diagnosticsError = SettingsErrorText(error)
        }
    }

    /// Presentation changes synchronously, before the task can reach the transport.
    @discardableResult
    public func send() -> Task<Void, Never>? {
        guard canSend else { return nil }
        if draft.client == nil {
            draft.client = clientMetadata
            let ids = attachments.compactMap(\.attachmentId)
            draft.attachmentIds = ids.isEmpty ? nil : ids
        }
        let request = draft
        let previouslyUnknown = hasUnknownOutcome
        hasUnknownOutcome = true
        persist()
        isSending = true
        error = nil
        isPresented = false
        confirmation.showSuccess(GitActionSuccess(title: String(localized: "Feedback sent")))
        return Task {
            guard isCurrent else { return }
            var unresolvedEarlierAttempt = previouslyUnknown
            /// One send, retried once with the identical payload when its outcome is unknown.
            @MainActor func attempt(_ request: FeedbackRequest) async throws -> FeedbackResult? {
                do { return try await submit(request) }
                catch {
                    guard isCurrent else { return nil }
                    guard Self.shouldRetry(error) else { throw error }
                    unresolvedEarlierAttempt = true
                    return try await submit(request)
                }
            }
            do {
                var result: FeedbackResult?
                do { result = try await attempt(request) }
                catch where !unresolvedEarlierAttempt && request.attachmentIds != nil && Self.isInvalid(error) {
                    // Staged IDs expire after an hour and stay bound to a report Relay refused, so a new report stages
                    // its files again. Never for an uncertain report: an earlier attempt may have been admitted.
                    guard isCurrent, let replacement = await restage(request) else { throw error }
                    result = try await attempt(replacement)
                }
                guard isCurrent, let result else { return }
                guard result.status == "sent", !result.reportId.isEmpty else {
                    throw APIError.decoding(underlying: CocoaError(.coderReadCorrupt))
                }
                draft = FeedbackRequest()
                hasUnknownOutcome = false
                defaults.removeObject(forKey: storageKey)
                clearAttachments()
                if result.attachments.contains(where: { $0.status == "refused" }) {
                    confirmation.showSuccess(GitActionSuccess(title: String(localized: "Sent without attachments")))
                }
            } catch {
                guard isCurrent else { return }
                hasUnknownOutcome = unresolvedEarlierAttempt || !Self.isRefusal(error)
                persist()
                if hasUnknownOutcome {
                    let guidance = String(localized: "The send could not be confirmed. Retry to check the same report.")
                    let serviceMessage = (error as? APIError)?.feedbackServiceMessage
                    self.error = SettingsErrorText(serviceMessage.map { "\($0)\n\(guidance)" } ?? guidance)
                } else {
                    self.error = SettingsErrorText(error)
                }
                confirmation.dismissSuccess()
                isPresented = true
            }
            isSending = false
        }
    }

    private var isEditable: Bool { isCurrent && !isSending && !hasUnknownOutcome }

    /// Uploads every retained file again and makes the draft a new report carrying the new IDs. Nil, leaving the failed
    /// thumbnails to retry, when an upload fails or the identity changed.
    private func restage(_ request: FeedbackRequest) async -> FeedbackRequest? {
        for index in attachments.indices { attachments[index].attachmentId = nil }
        for attachment in attachments { await upload(attachment.id) }
        guard isCurrent else { return nil }
        let ids = attachments.compactMap(\.attachmentId)
        guard ids.count == attachments.count else {
            persist()
            return nil
        }
        var replacement = request
        replacement.requestId = UUID()
        replacement.attachmentIds = ids
        draft = replacement
        persist()
        return replacement
    }

    /// After a refusal the stamped envelope is spent: any change makes a new report with its own request ID.
    private func startNewReportIfRefused() {
        guard draft.client != nil else { return }
        draft.requestId = UUID()
        draft.client = nil
        draft.attachmentIds = nil
    }

    private func add(_ attachment: FeedbackAttachment, encode: @escaping (URL) async throws -> Data?) -> Task<Void, Never> {
        attachmentError = nil
        attachments.append(attachment)
        uploadPhases[attachment.id] = .uploading
        startNewReportIfRefused()
        persist()
        return Task {
            do {
                try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
                let thumbnail = try await encode(stagingDirectory.appendingPathComponent(attachment.fileName))
                guard isCurrent, attachments.contains(where: { $0.id == attachment.id }) else {
                    return deleteStagedFiles(of: attachment)
                }
                if let thumbnail {
                    thumbnails[attachment.id] = thumbnail
                    try? thumbnail.write(to: stagingDirectory.appendingPathComponent(attachment.thumbnailName))
                }
            } catch {
                guard isCurrent, attachments.contains(where: { $0.id == attachment.id }) else { return }
                removeAttachment(attachment.id)
                attachmentError = SettingsErrorText(error)
                return
            }
            await upload(attachment.id)
        }
    }

    private func upload(_ id: UUID) async {
        guard let attachment = attachments.first(where: { $0.id == id }) else { return }
        uploadPhases[id] = .uploading
        do {
            let data = try Data(contentsOf: stagingDirectory.appendingPathComponent(attachment.fileName))
            let staged = try await uploadAttachment(data, attachment.contentType, attachment.fileName)
            guard isCurrent, let index = attachments.firstIndex(where: { $0.id == id }) else { return }
            attachments[index].attachmentId = staged.attachmentId
            uploadPhases[id] = nil
            persist()
        } catch {
            guard isCurrent, attachments.contains(where: { $0.id == id }) else { return }
            uploadPhases[id] = .failed(SettingsErrorText(error).message)
        }
    }

    private func deleteStagedFiles(of attachment: FeedbackAttachment) {
        try? FileManager.default.removeItem(at: stagingDirectory.appendingPathComponent(attachment.fileName))
        try? FileManager.default.removeItem(at: stagingDirectory.appendingPathComponent(attachment.thumbnailName))
    }

    private func clearAttachments() {
        attachments = []
        uploadPhases = [:]
        thumbnails = [:]
        currentScreen = nil
        attachmentError = nil
        try? FileManager.default.removeItem(at: stagingDirectory)
    }

    private func persist() {
        guard isCurrent else { return }
        if let data = try? JSONEncoder().encode(Stored(draft: draft, hasUnknownOutcome: hasUnknownOutcome, attachments: attachments)) {
            defaults.set(data, forKey: storageKey)
        }
    }

    /// Called after the shared server generation advances, for sign-out, removal, and identity changes.
    static func discardDraft(for server: URL, defaults: UserDefaults, stagingRoot: URL = defaultStagingRoot) {
        defaults.removeObject(forKey: storageKey(for: server))
        try? FileManager.default.removeItem(at: stagingDirectory(for: server, root: stagingRoot))
        for composer in composers.allObjects where composer.server == server {
            composer.clearAttachments()
            composer.attachmentOptions = nil
            composer.draft = FeedbackRequest()
            composer.diagnosticsText = nil
            composer.diagnosticsError = nil
            composer.error = nil
            composer.hasUnknownOutcome = false
            composer.isPresented = false
            composer.isSending = false
            composer.confirmation.dismissSuccess()
        }
    }

    private var isCurrent: Bool {
        server.map { ServerCacheGeneration.current(for: $0) == cacheGeneration } ?? true
    }

    private static func storageKey(for server: URL?) -> String {
        "feedback-draft.\(server?.absoluteString ?? "disconnected")"
    }

    private static func stagingDirectory(for server: URL?, root: URL) -> URL {
        let name = (server?.absoluteString ?? "disconnected").addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "server"
        return root.appendingPathComponent(name, isDirectory: true)
    }

    private static let currentScreenOfferID = UUID()

    private static func displayName(for attachment: FeedbackAttachment) -> String {
        switch attachment.contentType {
        case "video/mp4": String(localized: "Video")
        case "image/png": String(localized: "Current screen")
        default: String(localized: "Photo")
        }
    }

    private static func isRefusal(_ error: Error) -> Bool {
        if let api = error as? APIError,
           ["rate_limited", "feedback_unavailable", "invalid"].contains(api.serverMessage ?? "") { return true }
        return APIError.isDefinitiveWriteFailure(error)
    }

    private static func isInvalid(_ error: Error) -> Bool {
        (error as? APIError)?.serverMessage == "invalid"
    }

    private static func shouldRetry(_ error: Error) -> Bool {
        !APIError.isCancellation(error) && !isRefusal(error)
    }
}
