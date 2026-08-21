import XCTest
@testable import HermesMobile

final class SharedDraftStoreTests: XCTestCase {
    func testDraftTextCombinesTextAndURLsInOrder() {
        let draft = HermesShareDraft.draftText(
            textSnippets: [
                "  Summarize this page  ",
                "\nSummarize this page\n",
                "Key quote",
                "https://example.com/article"
            ],
            urls: [
                URL(string: "https://example.com/article")!,
                URL(string: "https://example.com/article")!,
                URL(string: "https://example.com/notes")!
            ]
        )

        XCTAssertEqual(
            draft,
            """
            Summarize this page

            Key quote

            https://example.com/article

            https://example.com/notes
            """
        )
    }

    func testDraftTextIgnoresEmptyInput() {
        let draft = HermesShareDraft.draftText(textSnippets: [" \n\t "], urls: [])

        XCTAssertEqual(draft, "")
    }

    func testComposerDraftAddsTrailingNewlineForFollowupInput() {
        XCTAssertEqual(
            HermesShareDraft.composerDraft(from: "  https://example.com/article  "),
            "https://example.com/article\n"
        )
        XCTAssertEqual(HermesShareDraft.composerDraft(from: " \n\t "), "")
    }

    func testShareOpenURLRecognizesOnlyHermesShareLinks() {
        let scheme = HermesShareDraft.urlScheme

        XCTAssertTrue(HermesShareDraft.isShareOpenURL(URL(string: "\(scheme)://share")!))
        XCTAssertFalse(HermesShareDraft.isShareOpenURL(URL(string: "\(scheme)://settings")!))
        XCTAssertFalse(HermesShareDraft.isShareOpenURL(URL(string: "https://example.com/share")!))
    }

    func testPendingDraftStorageLoadsAndClearsDraft() throws {
        let directory = try temporaryDirectory()

        try HermesShareDraft.savePendingDraft(
            "  Draft from Safari  ",
            in: directory,
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )

        let draft = try HermesShareDraft.loadPendingDraft(from: directory)
        XCTAssertEqual(draft, "Draft from Safari")
        XCTAssertNil(try HermesShareDraft.loadPendingDraft(from: directory))
    }

    func testPendingImportStorageLoadsAttachmentAndClearsStagedFiles() throws {
        let directory = try temporaryDirectory()
        let attachmentData = Data("pdf bytes".utf8)

        try HermesShareDraft.savePendingImport(
            draft: "  Review this  ",
            attachments: [
                SharedAttachmentImport(
                    filename: "/private/tmp/report.pdf",
                    typeIdentifier: "com.adobe.pdf",
                    data: attachmentData
                )
            ],
            in: directory,
            now: Date(timeIntervalSince1970: 1_800_000_001)
        )

        let sharedImport = try XCTUnwrap(try HermesShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.draft, "Review this")
        XCTAssertEqual(sharedImport.attachments.count, 1)
        XCTAssertEqual(sharedImport.attachments.first?.filename, "report.pdf")
        XCTAssertEqual(sharedImport.attachments.first?.typeIdentifier, "com.adobe.pdf")
        XCTAssertEqual(sharedImport.attachments.first?.data, attachmentData)
        XCTAssertNil(try HermesShareDraft.loadPendingImport(from: directory))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent(HermesShareDraft.pendingAttachmentsDirectoryName).path
            )
        )
    }

    func testOffMainActorPendingImportLoadsAndClearsStagedFiles() async throws {
        let directory = try temporaryDirectory()
        try HermesShareDraft.savePendingImport(
            draft: "Review this",
            attachments: [
                SharedAttachmentImport(
                    filename: "report.txt",
                    typeIdentifier: "public.plain-text",
                    data: Data("report".utf8)
                )
            ],
            in: directory
        )

        let loadedImport = try await HermesShareDraft.loadPendingImportOffMainActor(from: directory)
        let sharedImport = try XCTUnwrap(loadedImport)

        XCTAssertEqual(sharedImport.draft, "Review this")
        XCTAssertEqual(sharedImport.attachments.first?.data, Data("report".utf8))
        XCTAssertNil(try HermesShareDraft.loadPendingImport(from: directory))
    }

    func testPendingImportSupportsAttachmentOnlyShare() throws {
        let directory = try temporaryDirectory()

        try HermesShareDraft.savePendingImport(
            draft: " \n ",
            attachments: [
                SharedAttachmentImport(
                    filename: "photo.jpg",
                    typeIdentifier: "public.jpeg",
                    data: Data([0x01, 0x02, 0x03])
                )
            ],
            in: directory
        )

        let sharedImport = try XCTUnwrap(try HermesShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.draft, "")
        XCTAssertEqual(sharedImport.attachments.first?.filename, "photo.jpg")
        XCTAssertEqual(sharedImport.attachments.first?.data, Data([0x01, 0x02, 0x03]))
    }

    func testPendingImportKeepsMultipleUploadableAttachments() throws {
        let directory = try temporaryDirectory()

        try HermesShareDraft.savePendingImport(
            draft: "",
            attachments: [
                SharedAttachmentImport(
                    filename: "first.txt",
                    typeIdentifier: "public.plain-text",
                    data: Data("first".utf8)
                ),
                SharedAttachmentImport(
                    filename: "second.txt",
                    typeIdentifier: "public.plain-text",
                    data: Data("second".utf8)
                )
            ],
            in: directory
        )

        let sharedImport = try XCTUnwrap(try HermesShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.attachments.map(\.filename), ["first.txt", "second.txt"])
        XCTAssertEqual(sharedImport.attachments.map(\.data), [Data("first".utf8), Data("second".utf8)])
    }

    func testPendingImportCapsAttachmentsAtSharedLimit() throws {
        let directory = try temporaryDirectory()
        let attachments = (0..<(HermesShareDraft.maximumSharedAttachmentCount + 1)).map { index in
            SharedAttachmentImport(
                filename: "file-\(index).txt",
                typeIdentifier: "public.plain-text",
                data: Data("file-\(index)".utf8)
            )
        }

        try HermesShareDraft.savePendingImport(
            draft: "",
            attachments: attachments,
            in: directory
        )

        let sharedImport = try XCTUnwrap(try HermesShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.attachments.count, HermesShareDraft.maximumSharedAttachmentCount)
        XCTAssertEqual(sharedImport.attachments.first?.filename, "file-0.txt")
        XCTAssertEqual(sharedImport.attachments.last?.filename, "file-9.txt")
    }

    func testPendingImportLoadCapsAggregateAttachmentBytes() throws {
        let directory = try temporaryDirectory()
        let attachmentsDirectory = directory.appendingPathComponent(
            HermesShareDraft.pendingAttachmentsDirectoryName,
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: attachmentsDirectory, withIntermediateDirectories: true)

        let attachmentSize = HermesShareDraft.maximumSharedImportBytes / 2 + 1
        let attachments = ["first.bin", "second.bin"]
        for filename in attachments {
            try Data(count: attachmentSize).write(
                to: attachmentsDirectory.appendingPathComponent(filename)
            )
        }
        let payload = SharedDraftPayload(
            draft: "",
            createdAt: Date(),
            attachments: attachments.map {
                SharedAttachmentPayload(
                    filename: $0,
                    storedFileName: $0,
                    typeIdentifier: nil,
                    size: attachmentSize
                )
            }
        )
        try JSONEncoder().encode(payload).write(
            to: directory.appendingPathComponent(HermesShareDraft.pendingDraftFileName)
        )

        let sharedImport = try XCTUnwrap(
            try HermesShareDraft.loadPendingImport(from: directory, removeAfterLoad: false)
        )

        XCTAssertEqual(sharedImport.attachments.map(\.filename), ["first.bin"])
        XCTAssertLessThanOrEqual(
            sharedImport.attachments.reduce(0) { $0 + $1.data.count },
            HermesShareDraft.maximumSharedImportBytes
        )
    }

    func testPendingImportDecodesLegacyDraftOnlyPayload() throws {
        let directory = try temporaryDirectory()
        let payloadURL = directory.appendingPathComponent(HermesShareDraft.pendingDraftFileName)
        let legacyPayload = """
        {
          "draft": "Legacy note",
          "createdAt": 1800000002
        }
        """
        try Data(legacyPayload.utf8).write(to: payloadURL)

        let sharedImport = try XCTUnwrap(try HermesShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.draft, "Legacy note")
        XCTAssertTrue(sharedImport.attachments.isEmpty)
    }

    func testEmptyPendingDraftIsNotWritten() throws {
        let directory = try temporaryDirectory()

        try HermesShareDraft.savePendingDraft(" \n ", in: directory)

        XCTAssertNil(try HermesShareDraft.loadPendingDraft(from: directory))
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
