import Foundation
import Observation
import UniformTypeIdentifiers

struct ChatAttachmentSendPreparation {
    let attachments: [PendingAttachment]
    let messageAttachments: [MessageAttachment]

    var apiPayloads: [JSONValue]? {
        attachments.isEmpty ? nil : attachments.map { $0.toJSONValue() }
    }
}

@MainActor
protocol ChatAttachmentCoordinatorDelegate: AnyObject {
    var attachmentSessionID: String? { get }
    var attachmentIsViewingCachedData: Bool { get }
    var attachmentContextID: String { get }

    func attachmentCoordinatorWillUpload()
    func attachmentCoordinatorDidFail(_ error: Error)
}

extension ChatAttachmentCoordinatorDelegate {
    var attachmentContextID: String { attachmentSessionID ?? "" }
}

@MainActor
@Observable
final class ChatAttachmentCoordinator {
    private(set) var pendingAttachments: [PendingAttachment] = []
    private(set) var uploadAttachmentErrorMessage: String?
    private(set) var localAttachmentPreviews: [String: [String: Data]] = [:]
    private var activeUploadCount = 0
    private var stagingCount = 0
    private var generation = 0
    private var stagedContexts: [UUID: String] = [:]
    private var uploadingIDs = Set<UUID>()
    private var isDraining = false
    private(set) var uploadStartGeneration = 0
    /// The server's per-message attachment cap, learned from its upload responses (TAL-635).
    private(set) var maxAttachmentsPerMessage: Int?

    var isUploadingAttachment: Bool {
        activeUploadCount > 0 || stagingCount > 0
            || pendingAttachments.contains { $0.uploadPhase == .staged || $0.uploadPhase == .uploading }
    }

    var uploadInFlightCount: Int {
        activeUploadCount
    }

    weak var delegate: ChatAttachmentCoordinatorDelegate?

    private let client: APIClient
    private let draftAttachmentStore: any ChatDraftAttachmentStoring
    private var reservedUploadFilenames: Set<String> = []

    init(
        client: APIClient,
        draftAttachmentStore: any ChatDraftAttachmentStoring = ChatDraftAttachmentStore.shared
    ) {
        self.client = client
        self.draftAttachmentStore = draftAttachmentStore
    }

    /// Every input saves and publishes its local intent before the batch starts network work.
    @discardableResult
    func stageAttachment(data: Data, filename: String, previewData: Data? = nil) async -> PendingAttachment? {
        guard !Task.isCancelled else { return nil }
        guard data.count <= PendingAttachment.maximumUploadBytes else {
            uploadAttachmentErrorMessage = PendingAttachment.uploadTooLargeMessage(filename: filename)
            return nil
        }
        if let cap = reachedAttachmentCap {
            uploadAttachmentErrorMessage = String(localized: "A message can carry up to \(cap) attachments.")
            return nil
        }
        let expectedGeneration = generation
        let context = delegate?.attachmentContextID ?? ""
        stagingCount += 1
        var ownsReservation = true
        defer { if ownsReservation { stagingCount -= 1 } }
        do {
            let file = try await draftAttachmentStore.save(data: data, suggestedFilename: filename)
            guard !Task.isCancelled, expectedGeneration == generation,
                  context == delegate?.attachmentContextID else {
                await draftAttachmentStore.delete(named: file)
                return nil
            }
            let type = UTType(filenameExtension: URL(fileURLWithPath: filename).pathExtension)
            let id = UUID()
            let attachment = PendingAttachment(
                id: id, name: Self.normalizedAttachmentFilename(filename), path: "local-attachment:\(id)",
                mime: type?.preferredMIMEType ?? "application/octet-stream", size: data.count,
                isImage: previewData != nil || type?.conforms(to: .image) == true,
                thumbnailData: nil, draftFileName: file, uploadPhase: .staged
            )
            pendingAttachments.append(attachment)
            stagingCount -= 1
            ownsReservation = false
            stagedContexts[attachment.id] = context
            if attachment.isImage {
                let thumbnail = await ImagePreviewDownsampler.previewDataAsync(
                    from: previewData ?? data, maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
                )
                guard expectedGeneration == generation, context == delegate?.attachmentContextID,
                      let index = pendingAttachments.firstIndex(where: { $0.id == attachment.id }) else { return nil }
                pendingAttachments[index].thumbnailData = thumbnail
                return pendingAttachments[index]
            }
            return attachment
        } catch {
            uploadAttachmentErrorMessage = String(localized: "Could not save the attachment on this device.")
            delegate?.attachmentCoordinatorDidFail(error)
            return nil
        }
    }

    @discardableResult
    func uploadAttachment(data: Data, filename: String, previewData: Data? = nil) async -> PendingAttachment? {
        guard let staged = await stageAttachment(data: data, filename: filename, previewData: previewData) else { return nil }
        return await retryAttachment(id: staged.id)
    }

    /// Called once after a selection is staged, preserving the existing sequential upload policy.
    func uploadStagedAttachments(ids: [UUID]? = nil) async {
        let selected = Set(ids ?? pendingAttachments.map(\.id))
        for index in pendingAttachments.indices where selected.contains(pendingAttachments[index].id) && pendingAttachments[index].uploadPhase == .staged {
            pendingAttachments[index].uploadPhase = .uploading
        }
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }
        var attempted = Set<UUID>()
        while let id = pendingAttachments.first(where: { $0.uploadPhase == .uploading && !attempted.contains($0.id) })?.id {
            attempted.insert(id)
            _ = await retryAttachment(id: id)
        }
    }

    @discardableResult
    func retryAttachment(id: UUID, data restoredData: Data? = nil, reportsErrors: Bool = true) async -> PendingAttachment? {
        guard !uploadingIDs.contains(id),
              let staged = pendingAttachments.first(where: { $0.id == id }),
              !staged.isReadyToSend, let file = staged.draftFileName,
              stagedContexts[id] == delegate?.attachmentContextID else { return nil }
        let expectedGeneration = generation
        if let cap = maxAttachmentsPerMessage,
           let index = pendingAttachments.firstIndex(where: { $0.id == id }), index >= cap {
            pendingAttachments[index].uploadPhase = .failed(String(localized: "A message can carry up to \(cap) attachments."))
            return nil
        }
        uploadingIDs.insert(id)
        defer { uploadingIDs.remove(id) }
        if let index = pendingAttachments.firstIndex(where: { $0.id == id }) {
            pendingAttachments[index].uploadPhase = .uploading
        }
        let result: PendingAttachment?
        do {
            let data: Data
            if let restoredData { data = restoredData } else { data = try await draftAttachmentStore.data(named: file) }
            guard expectedGeneration == generation, stagedContexts[id] == delegate?.attachmentContextID,
                  pendingAttachments.contains(where: { $0.id == id }) else { return nil }
            result = await performUpload(
                data: data, filename: staged.name, previewData: staged.thumbnailData,
                draftFileName: file, draftAttachmentID: id, reportsErrors: reportsErrors
            )
        } catch {
            uploadAttachmentErrorMessage = error.localizedDescription
            result = nil
        }
        guard let index = pendingAttachments.firstIndex(where: { $0.id == id }) else { return nil }
        guard stagedContexts[id] == delegate?.attachmentContextID else {
            pendingAttachments[index].uploadPhase = .failed(String(localized: "This attachment belongs to another chat or profile. Switch back to retry, or remove it."))
            return nil
        }
        guard expectedGeneration == generation else { return nil }
        if let result {
            pendingAttachments[index] = result
        } else {
            pendingAttachments[index].uploadPhase = .failed(uploadAttachmentErrorMessage ?? String(localized: "Upload failed."))
        }
        return result
    }

    func saveLocalAudio(data: Data, filename: String) async throws -> String {
        try await draftAttachmentStore.save(data: data, suggestedFilename: filename)
    }

    func localData(named file: String) async throws -> Data { try await draftAttachmentStore.data(named: file) }

    /// Restored drafts keep their durable identity even when their upload fails.
    @discardableResult
    func reuploadDraftAttachment(data: Data, draftAttachment: ChatDraftAttachment) async -> PendingAttachment? {
        guard reachedAttachmentCap == nil, let file = draftAttachment.file else { return nil }
        guard !pendingAttachments.contains(where: { $0.id == draftAttachment.id }) else { return nil }
        let thumbnail = draftAttachment.isImage ? await ImagePreviewDownsampler.previewDataAsync(
            from: data, maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
        ) : nil
        let staged = PendingAttachment(
            id: draftAttachment.id, name: draftAttachment.name, path: "local-attachment:\(draftAttachment.id)", mime: draftAttachment.mime,
            size: draftAttachment.size, isImage: draftAttachment.isImage, thumbnailData: thumbnail,
            draftFileName: file, uploadPhase: .uploading
        )
        pendingAttachments.append(staged)
        stagedContexts[staged.id] = delegate?.attachmentContextID
        return await retryAttachment(id: staged.id, data: data, reportsErrors: false)
    }

    /// The server keeps only this many attachments on a message, so one more would be dropped
    /// silently on send; staging stops at the cap instead (TAL-635). Nil while there is room.
    private var reachedAttachmentCap: Int? {
        guard let maxAttachmentsPerMessage,
              pendingAttachments.count + stagingCount >= maxAttachmentsPerMessage
        else { return nil }
        return maxAttachmentsPerMessage
    }

    /// Uploads a single file and returns it as a `PendingAttachment` *without*
    /// adding it to `pendingAttachments`. The voice-note flow uses this: the clip
    /// is sent as the sole attachment of its own message, so it must not sweep up
    /// the user's typed draft or other staged attachments — and it is never part
    /// of a persisted draft. Failures surface via `uploadAttachmentErrorMessage`
    /// and the method returns nil.
    func uploadStandaloneAttachment(data: Data, filename: String) async -> PendingAttachment? {
        await performUpload(
            data: data,
            filename: filename,
            previewData: nil,
            draftFileName: nil,
            draftAttachmentID: nil,
            reportsErrors: true,
            preferredUploadFilename: Self.uniquedAttachmentFilename(filename)
        )
    }

    private func performUpload(
        data: Data,
        filename: String,
        previewData: Data?,
        draftFileName: String?,
        draftAttachmentID: UUID?,
        reportsErrors: Bool,
        preferredUploadFilename: String? = nil
    ) async -> PendingAttachment? {
        guard delegate?.attachmentIsViewingCachedData != true else {
            if reportsErrors {
                uploadAttachmentErrorMessage = String(localized: "Reconnect to the server to upload attachments.")
            }
            return nil
        }

        guard data.count <= PendingAttachment.maximumUploadBytes else {
            if reportsErrors {
                uploadAttachmentErrorMessage = PendingAttachment.uploadTooLargeMessage(filename: filename)
            }
            return nil
        }

        guard let sessionID = delegate?.attachmentSessionID else {
            if reportsErrors {
                uploadAttachmentErrorMessage = String(localized: "The server did not provide a session ID.")
            }
            return nil
        }

        let expectedGeneration = generation
        let expectedContext = delegate?.attachmentContextID
        let displayFilename = Self.normalizedAttachmentFilename(filename)
        let uploadFilename = reserveUploadFilename(preferredFilename: preferredUploadFilename ?? displayFilename, excluding: draftAttachmentID)

        activeUploadCount += 1
        uploadStartGeneration += 1
        if reportsErrors {
            delegate?.attachmentCoordinatorWillUpload()
        }
        defer {
            releaseReservedUploadFilename(uploadFilename)
            activeUploadCount = max(activeUploadCount - 1, 0)
        }

        do {
            let response = try await client.uploadFile(sessionID: sessionID, data: data, filename: uploadFilename)
            guard expectedGeneration == generation, expectedContext == delegate?.attachmentContextID, !Task.isCancelled else { return nil }
            if let errorMessage = response.error {
                if reportsErrors {
                    uploadAttachmentErrorMessage = errorMessage
                }
                return nil
            }

            guard let path = response.path, !path.isEmpty else {
                if reportsErrors {
                    uploadAttachmentErrorMessage = String(localized: "The server did not return the uploaded file path.")
                }
                return nil
            }

            if let cap = response.maxAttachmentsPerMessage, cap > 0 {
                maxAttachmentsPerMessage = cap
            }
            let thumbnail = await Self.thumbnailData(for: response, originalData: data, previewData: previewData)
            guard expectedGeneration == generation, expectedContext == delegate?.attachmentContextID, !Task.isCancelled else { return nil }
            return PendingAttachment(
                id: draftAttachmentID ?? UUID(),
                name: displayFilename,
                path: path,
                mime: response.mime ?? "application/octet-stream",
                size: response.size,
                isImage: response.isImage ?? false,
                thumbnailData: thumbnail,
                draftFileName: draftFileName
            )
        } catch {
            guard expectedGeneration == generation, expectedContext == delegate?.attachmentContextID else { return nil }
            if reportsErrors {
                delegate?.attachmentCoordinatorDidFail(error)
                uploadAttachmentErrorMessage = error.localizedDescription
            }
            return nil
        }
    }

    func suspendPendingUploads() {
        generation += 1
        for index in pendingAttachments.indices where pendingAttachments[index].uploadPhase == .uploading || pendingAttachments[index].uploadPhase == .staged {
            pendingAttachments[index].uploadPhase = .failed(String(localized: "Upload paused. Try again."))
        }
    }

    func clearPendingAttachments() {
        generation += 1
        stagedContexts.removeAll()
        pendingAttachments.removeAll()
        uploadAttachmentErrorMessage = nil
    }

    func removePendingAttachment(id: UUID) {
        let file = pendingAttachments.first(where: { $0.id == id })?.draftFileName
        stagedContexts[id] = nil
        pendingAttachments.removeAll { $0.id == id }
        if let file { Task { await draftAttachmentStore.delete(named: file) } }
    }

    func setUploadAttachmentError(_ message: String?) {
        uploadAttachmentErrorMessage = message
    }

    func deleteDraftCopy(named fileName: String) async {
        await draftAttachmentStore.delete(named: fileName)
    }

    func attachmentImageData(path: String) async -> Data? {
        if let file = pendingAttachments.first(where: { $0.path == path })?.draftFileName {
            guard let data = try? await draftAttachmentStore.data(named: file) else { return nil }
            return await ImagePreviewDownsampler.previewDataAsync(from: data, maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize)
        }
        guard let sessionID = delegate?.attachmentSessionID else { return nil }

        do {
            let data = try await client.rawFileData(sessionID: sessionID, path: path)
            return await ImagePreviewDownsampler.previewDataAsync(
                from: data,
                maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
            )
        } catch {
            return nil
        }
    }

    /// Raw attachment bytes with no image downsampling — used by the inline
    /// audio player, which needs the original encoded audio data intact.
    func attachmentRawData(path: String) async -> Data? {
        if let file = pendingAttachments.first(where: { $0.path == path })?.draftFileName {
            return try? await draftAttachmentStore.data(named: file)
        }
        guard let sessionID = delegate?.attachmentSessionID else { return nil }

        do {
            return try await client.rawFileData(sessionID: sessionID, path: path)
        } catch {
            return nil
        }
    }

    func transcriptMediaThumbnailData(for reference: TranscriptMediaReference) async -> Data? {
        guard reference.isRasterImageCandidate else { return nil }

        do {
            let data = try await client.transcriptMediaData(for: reference)
            return await ImagePreviewDownsampler.previewDataAsync(
                from: data,
                maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
            ) ?? data
        } catch {
            return nil
        }
    }

    /// Raw transcript media bytes for inline audio/video playback; the server's URL names its session.
    func transcriptMediaData(for reference: TranscriptMediaReference) async -> Data? {
        do {
            return try await client.transcriptMediaData(for: reference)
        } catch {
            return nil
        }
    }

    /// Sends `queued` files when given (a queued message's own), leaving the composer's staged files alone.
    func prepareForSend(_ queued: [PendingAttachment]? = nil, localMessageID: String) -> ChatAttachmentSendPreparation {
        let attachmentsForSend = queued ?? pendingAttachments
        let messageAttachments = attachmentsForSend.map { pending in
            MessageAttachment(
                name: pending.name,
                path: pending.path,
                mime: pending.mime,
                size: pending.size,
                isImage: pending.isImage
            )
        }

        var previews: [String: Data] = [:]
        for pending in attachmentsForSend {
            if let data = pending.thumbnailData {
                previews[pending.path] = data
            }
        }
        if !previews.isEmpty {
            localAttachmentPreviews[localMessageID] = previews
        }

        if queued == nil {
            for attachment in attachmentsForSend { stagedContexts[attachment.id] = nil }
            pendingAttachments.removeAll()
        }
        return ChatAttachmentSendPreparation(
            attachments: attachmentsForSend,
            messageAttachments: messageAttachments
        )
    }

    func restorePendingAttachments(_ attachments: [PendingAttachment]) {
        guard !attachments.isEmpty else { return }
        pendingAttachments = attachments + pendingAttachments
    }

    func consumePendingAttachments() -> [PendingAttachment] {
        let attachments = pendingAttachments
        for attachment in attachments { stagedContexts[attachment.id] = nil }
        pendingAttachments.removeAll()
        return attachments
    }

    func removeLocalPreviews(messageID: String) {
        localAttachmentPreviews[messageID] = nil
    }

    func removeAllLocalPreviews() {
        localAttachmentPreviews.removeAll()
    }

    func mergeLocalAttachmentPreviews(_ previews: [String: [String: Data]]) {
        localAttachmentPreviews.merge(previews) { current, _ in current }
    }

    private func reserveUploadFilename(preferredFilename: String, excluding id: UUID?) -> String {
        var existingKeys = reservedUploadFilenames
        for attachment in pendingAttachments where attachment.id != id {
            existingKeys.insert(Self.filenameKey(attachment.name))
            let uploadedFilename = URL(fileURLWithPath: attachment.path).lastPathComponent
            if !uploadedFilename.isEmpty {
                existingKeys.insert(Self.filenameKey(uploadedFilename))
            }
        }

        var candidate = preferredFilename
        while existingKeys.contains(Self.filenameKey(candidate)) {
            candidate = Self.uniquedAttachmentFilename(preferredFilename)
        }

        reservedUploadFilenames.insert(Self.filenameKey(candidate))
        return candidate
    }

    private func releaseReservedUploadFilename(_ filename: String) {
        reservedUploadFilenames.remove(Self.filenameKey(filename))
    }

    nonisolated private static func normalizedAttachmentFilename(_ filename: String) -> String {
        let lastPathComponent = URL(fileURLWithPath: filename).lastPathComponent
        let trimmed = lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "attachment" : trimmed
    }

    nonisolated private static func filenameKey(_ filename: String) -> String {
        normalizedAttachmentFilename(filename).lowercased()
    }

    nonisolated private static func uniquedAttachmentFilename(_ filename: String) -> String {
        let normalized = normalizedAttachmentFilename(filename)
        let url = URL(fileURLWithPath: normalized)
        let fileExtension = url.pathExtension
        let baseName = url.deletingPathExtension().lastPathComponent
        let safeBaseName = baseName.isEmpty ? "attachment" : baseName
        let suffix = UUID().uuidString.prefix(8).lowercased()

        guard !fileExtension.isEmpty else {
            return "\(safeBaseName)-\(suffix)"
        }

        return "\(safeBaseName)-\(suffix).\(fileExtension)"
    }

    nonisolated private static func thumbnailData(
        for response: UploadResponse,
        originalData: Data,
        previewData: Data?
    ) async -> Data? {
        guard response.isImage == true else { return nil }

        return await ImagePreviewDownsampler.previewDataAsync(
            from: previewData ?? originalData,
            maxPixelSize: ImagePreviewDownsampler.attachmentMaxPixelSize
        )
    }
}
