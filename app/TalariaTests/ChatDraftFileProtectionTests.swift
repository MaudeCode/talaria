import XCTest
@testable import TalariaKit

/// Unsent drafts and their attachments hold the user's words and files, so the stores write them under data protection
/// that keeps them sealed until the first unlock after a restart. Only iOS builds apply a protection class, so this proof
/// needs the App host; `swift test` on macOS cannot see it. The simulator neither enforces nor reports a protection
/// class, so the test records what each store asks the file system for, through the stores' own `fileManager`.
final class ChatDraftFileProtectionTests: XCTestCase {
    func testDraftsAndTheirAttachmentsAreWrittenUnderDataProtection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorder = ProtectionRecorder()

        try await ChatDraftFilePersistence(fileManager: ProtectionRecordingFileManager(recorder), directoryURL: directory).write([
            ChatDraftKey(serverID: "https://example.com", context: .newChat(window: nil)): ChatDraft(text: "Protected prompt")
        ])
        let attachmentName = try await ChatDraftAttachmentStore(fileManager: ProtectionRecordingFileManager(recorder), directoryURL: directory)
            .save(data: Data("attachment bytes".utf8), suggestedFilename: "photo.jpg")

        let drafts = directory.appendingPathComponent("ChatDrafts", isDirectory: true)
        let attachments = drafts.appendingPathComponent("Attachments", isDirectory: true)
        let written = [drafts, drafts.appendingPathComponent("drafts.json"), attachments, attachments.appendingPathComponent(attachmentName)]
        XCTAssertEqual(recorder.protections, Dictionary(uniqueKeysWithValues: written.map {
            ($0.standardizedFileURL.path, FileProtectionType.completeUntilFirstUserAuthentication)
        }))
    }
}

private final class ProtectionRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String: FileProtectionType] = [:]
    var protections: [String: FileProtectionType] { lock.withLock { recorded } }

    func record(_ protection: FileProtectionType, at path: String) {
        lock.withLock { recorded[URL(fileURLWithPath: path).standardizedFileURL.path] = protection }
    }
}

private final class ProtectionRecordingFileManager: FileManager {
    private let recorder: ProtectionRecorder

    init(_ recorder: ProtectionRecorder) {
        self.recorder = recorder
        super.init()
    }

    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if let protection = attributes[.protectionKey] as? FileProtectionType {
            recorder.record(protection, at: path)
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}
