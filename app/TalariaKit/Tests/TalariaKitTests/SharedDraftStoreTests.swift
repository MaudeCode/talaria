import XCTest
@testable import TalariaKit

final class SharedDraftStoreTests: XCTestCase {
    func testDraftTextCombinesTextAndURLsInOrder() {
        let draft = TalariaShareDraft.draftText(
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
        let draft = TalariaShareDraft.draftText(textSnippets: [" \n\t "], urls: [])

        XCTAssertEqual(draft, "")
    }

    func testComposerDraftAddsTrailingNewlineForFollowupInput() {
        XCTAssertEqual(
            TalariaShareDraft.composerDraft(from: "  https://example.com/article  "),
            "https://example.com/article\n"
        )
        XCTAssertEqual(TalariaShareDraft.composerDraft(from: " \n\t "), "")
    }

    func testShareOpenURLRecognizesOnlyTalariaShareLinks() {
        let scheme = TalariaShareDraft.urlScheme

        XCTAssertTrue(TalariaShareDraft.isShareOpenURL(URL(string: "\(scheme)://share")!))
        XCTAssertFalse(TalariaShareDraft.isShareOpenURL(URL(string: "\(scheme)://settings")!))
        XCTAssertFalse(TalariaShareDraft.isShareOpenURL(URL(string: "https://example.com/share")!))
    }

    func testPendingDraftStorageLoadsAndClearsDraft() throws {
        let directory = try temporaryDirectory()

        try TalariaShareDraft.savePendingDraft(
            "  Draft from Safari  ",
            in: directory,
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )

        let draft = try TalariaShareDraft.loadPendingDraft(from: directory)
        XCTAssertEqual(draft, "Draft from Safari")
        XCTAssertNil(try TalariaShareDraft.loadPendingDraft(from: directory))
    }

    func testPendingImportStorageLoadsAttachmentAndClearsStagedFiles() throws {
        let directory = try temporaryDirectory()
        let attachmentData = Data("pdf bytes".utf8)

        try TalariaShareDraft.savePendingImport(
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

        let sharedImport = try XCTUnwrap(try TalariaShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.draft, "Review this")
        XCTAssertEqual(sharedImport.attachments.count, 1)
        XCTAssertEqual(sharedImport.attachments.first?.filename, "report.pdf")
        XCTAssertEqual(sharedImport.attachments.first?.typeIdentifier, "com.adobe.pdf")
        XCTAssertEqual(sharedImport.attachments.first?.data, attachmentData)
        XCTAssertNil(try TalariaShareDraft.loadPendingImport(from: directory))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent(TalariaShareDraft.pendingAttachmentsDirectoryName).path
            )
        )
    }

    func testPendingImportSupportsAttachmentOnlyShare() throws {
        let directory = try temporaryDirectory()

        try TalariaShareDraft.savePendingImport(
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

        let sharedImport = try XCTUnwrap(try TalariaShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.draft, "")
        XCTAssertEqual(sharedImport.attachments.first?.filename, "photo.jpg")
        XCTAssertEqual(sharedImport.attachments.first?.data, Data([0x01, 0x02, 0x03]))
    }

    func testPendingImportKeepsMultipleUploadableAttachments() throws {
        let directory = try temporaryDirectory()

        try TalariaShareDraft.savePendingImport(
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

        let sharedImport = try XCTUnwrap(try TalariaShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.attachments.map(\.filename), ["first.txt", "second.txt"])
        XCTAssertEqual(sharedImport.attachments.map(\.data), [Data("first".utf8), Data("second".utf8)])
    }

    func testPendingImportCapsAttachmentsAtSharedLimit() throws {
        let directory = try temporaryDirectory()
        let attachments = (0..<(TalariaShareDraft.maximumSharedAttachmentCount + 1)).map { index in
            SharedAttachmentImport(
                filename: "file-\(index).txt",
                typeIdentifier: "public.plain-text",
                data: Data("file-\(index)".utf8)
            )
        }

        try TalariaShareDraft.savePendingImport(
            draft: "",
            attachments: attachments,
            in: directory
        )

        let sharedImport = try XCTUnwrap(try TalariaShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.attachments.count, TalariaShareDraft.maximumSharedAttachmentCount)
        XCTAssertEqual(sharedImport.attachments.first?.filename, "file-0.txt")
        XCTAssertEqual(sharedImport.attachments.last?.filename, "file-9.txt")
    }

    func testInboxKeepsTwoSharesAndReservesThemOldestFirst() throws {
        let directory = try temporaryDirectory()
        let firstDate = Date(timeIntervalSince1970: 1_800_000_010)
        let secondDate = Date(timeIntervalSince1970: 1_800_000_020)

        try TalariaShareDraft.savePendingDraft("First share", in: directory, now: firstDate)
        try TalariaShareDraft.savePendingDraft("Second share", in: directory, now: secondDate)
        XCTAssertTrue(try TalariaShareDraft.hasPendingImport(in: directory, now: secondDate))

        let first = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory, now: secondDate)
        )
        XCTAssertEqual(first.sharedImport.draft, "First share")
        XCTAssertEqual(first.createdAt, firstDate)
        XCTAssertTrue(try TalariaShareDraft.hasPendingImport(in: directory, now: secondDate))
        try TalariaShareDraft.consume(first, from: directory)

        let second = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory, now: secondDate)
        )
        XCTAssertEqual(second.sharedImport.draft, "Second share")
        XCTAssertEqual(second.createdAt, secondDate)
        try TalariaShareDraft.consume(second, from: directory)

        XCTAssertFalse(try TalariaShareDraft.hasPendingImport(in: directory, now: secondDate))
        XCTAssertNil(try TalariaShareDraft.reserveNextPendingImport(from: directory, now: secondDate))
    }

    func testInboxDeduplicatesRepeatedPendingContent() throws {
        let directory = try temporaryDirectory()

        try TalariaShareDraft.savePendingDraft(
            "Repeated share",
            in: directory,
            now: Date(timeIntervalSince1970: 1_800_000_030)
        )
        try TalariaShareDraft.savePendingDraft(
            "Repeated share",
            in: directory,
            now: Date(timeIntervalSince1970: 1_800_000_040)
        )

        let reservation = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory)
        )
        try TalariaShareDraft.savePendingDraft(
            "Repeated share",
            in: directory,
            now: Date(timeIntervalSince1970: 1_800_000_050)
        )
        try TalariaShareDraft.consume(reservation, from: directory)

        XCTAssertNil(try TalariaShareDraft.reserveNextPendingImport(from: directory))
    }

    func testReleasedReservationCanBeReservedAgain() throws {
        let directory = try temporaryDirectory()
        try TalariaShareDraft.savePendingDraft("Route me later", in: directory)

        let first = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory)
        )
        try TalariaShareDraft.release(first, in: directory)

        let second = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory)
        )
        XCTAssertEqual(second.itemID, first.itemID)
        XCTAssertNotEqual(second.reservationID, first.reservationID)
        XCTAssertEqual(second.sharedImport, first.sharedImport)
    }

    func testExpiredReservationReturnsToInboxWithNewOwnership() throws {
        let directory = try temporaryDirectory()
        let reservationDate = Date(timeIntervalSince1970: 1_800_000_050)
        try TalariaShareDraft.savePendingDraft("Recover me", in: directory, now: reservationDate)

        let expired = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory, now: reservationDate)
        )
        let recovered = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(
                from: directory,
                now: reservationDate.addingTimeInterval(TalariaShareDraft.reservationLifetime + 1)
            )
        )

        XCTAssertEqual(recovered.itemID, expired.itemID)
        XCTAssertNotEqual(recovered.reservationID, expired.reservationID)
        XCTAssertThrowsError(try TalariaShareDraft.consume(expired, from: directory))
        try TalariaShareDraft.consume(recovered, from: directory)
    }

    func testMissingAttachmentOnlyItemDoesNotBlockLaterShare() throws {
        let directory = try temporaryDirectory()
        let attachmentDate = Date(timeIntervalSince1970: 1_800_000_060)
        try TalariaShareDraft.savePendingImport(
            draft: "",
            attachments: [
                SharedAttachmentImport(
                    filename: "missing.txt",
                    typeIdentifier: "public.plain-text",
                    data: Data("gone".utf8)
                )
            ],
            in: directory,
            now: attachmentDate
        )
        try TalariaShareDraft.savePendingDraft(
            "Still valid",
            in: directory,
            now: attachmentDate.addingTimeInterval(1)
        )

        for fileURL in try attachmentFileURLs(in: directory) {
            try FileManager.default.removeItem(at: fileURL)
        }

        let reservation = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory)
        )
        XCTAssertEqual(reservation.sharedImport.draft, "Still valid")
        try TalariaShareDraft.consume(reservation, from: directory)
        XCTAssertNil(try TalariaShareDraft.reserveNextPendingImport(from: directory))
    }

    func testMissingAttachmentDoesNotDiscardRemainingSharedContent() throws {
        let directory = try temporaryDirectory()
        try TalariaShareDraft.savePendingImport(
            draft: "Review what remains",
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

        let attachmentFiles = try attachmentFileURLs(in: directory)
        XCTAssertEqual(attachmentFiles.count, 2)
        try FileManager.default.removeItem(at: attachmentFiles[0])

        let reservation = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory)
        )
        XCTAssertEqual(reservation.sharedImport.draft, "Review what remains")
        XCTAssertEqual(reservation.sharedImport.attachments.count, 1)
        try TalariaShareDraft.consume(reservation, from: directory)
    }

    func testFailedInboxPreparationDoesNotOverwriteExistingFile() throws {
        let parent = try temporaryDirectory()
        let fileURL = parent.appendingPathComponent("not-a-directory")
        let originalData = Data("keep me".utf8)
        try originalData.write(to: fileURL)

        XCTAssertThrowsError(
            try TalariaShareDraft.savePendingDraft("Unsaved share", in: fileURL)
        )
        XCTAssertEqual(try Data(contentsOf: fileURL), originalData)
    }

    func testPendingImportDecodesLegacyDraftOnlyPayload() throws {
        let directory = try temporaryDirectory()
        let payloadURL = directory.appendingPathComponent(TalariaShareDraft.pendingDraftFileName)
        let legacyPayload = """
        {
          "draft": "Legacy note",
          "createdAt": 1800000002
        }
        """
        try Data(legacyPayload.utf8).write(to: payloadURL)

        let sharedImport = try XCTUnwrap(try TalariaShareDraft.loadPendingImport(from: directory))

        XCTAssertEqual(sharedImport.draft, "Legacy note")
        XCTAssertTrue(sharedImport.attachments.isEmpty)
    }

    func testMalformedLegacyPayloadDoesNotBlockTransactionalInbox() throws {
        let directory = try temporaryDirectory()
        try TalariaShareDraft.savePendingDraft("Valid new share", in: directory)

        let legacyPayloadURL = directory.appendingPathComponent(TalariaShareDraft.pendingDraftFileName)
        try Data("not json".utf8).write(to: legacyPayloadURL)
        let legacyAttachmentsURL = directory.appendingPathComponent(
            TalariaShareDraft.pendingAttachmentsDirectoryName,
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: legacyAttachmentsURL, withIntermediateDirectories: true)
        try Data("orphan".utf8).write(to: legacyAttachmentsURL.appendingPathComponent("orphan.txt"))

        let reservation = try XCTUnwrap(
            try TalariaShareDraft.reserveNextPendingImport(from: directory)
        )

        XCTAssertEqual(reservation.sharedImport.draft, "Valid new share")
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyPayloadURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyAttachmentsURL.path))
    }

    func testEmptyPendingDraftIsNotWritten() throws {
        let directory = try temporaryDirectory()

        try TalariaShareDraft.savePendingDraft(" \n ", in: directory)

        XCTAssertNil(try TalariaShareDraft.loadPendingDraft(from: directory))
    }

    func testOffMainActorReservationLoadsAndConsumesStagedFiles() async throws {
        let directory = try temporaryDirectory()
        try TalariaShareDraft.savePendingImport(
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

        let reserved = try await TalariaShareDraft.reserveNextPendingImportOffMainActor(from: directory)
        let reservation = try XCTUnwrap(reserved)
        XCTAssertEqual(reservation.sharedImport.draft, "Review this")
        XCTAssertEqual(reservation.sharedImport.attachments.first?.data, Data("report".utf8))

        try await TalariaShareDraft.consumeOffMainActor(reservation, from: directory)
        let hasPendingImport = try await TalariaShareDraft.hasPendingImportOffMainActor(in: directory)
        XCTAssertFalse(hasPendingImport)
    }

    /// TAL-554: launch, foreground, and the share URL fire together; only one reservation may win.
    @MainActor
    func testConcurrentImportTriggersRouteTwoQueuedSharesOneAfterAnother() async throws {
        let directory = try temporaryDirectory()
        try TalariaShareDraft.savePendingDraft("First share", in: directory, now: Date(timeIntervalSinceNow: -2))
        try TalariaShareDraft.savePendingDraft("Second share", in: directory, now: Date(timeIntervalSinceNow: -1))
        let router = SharedImportRouter(directory: { directory })

        let triggers = (0..<3).map { _ in Task { await router.importIfAvailable() } }
        for trigger in triggers { await trigger.value }

        let first = try XCTUnwrap(router.pendingImport)
        XCTAssertEqual(first.sharedImport.draft, "First share")
        XCTAssertTrue(router.hasWaitingImport)

        await router.didRoute(first).value
        XCTAssertNil(router.pendingImport)
        XCTAssertTrue(router.hasWaitingImport)

        await router.openNext().value
        let second = try XCTUnwrap(router.pendingImport)
        XCTAssertEqual(second.sharedImport.draft, "Second share")

        await router.didRoute(second).value
        XCTAssertNil(router.pendingImport)
        XCTAssertFalse(router.hasWaitingImport)
    }

    func testPendingImportSaveRejectsAggregateOverflowWithoutReplacingExistingDraft() throws {
        let directory = try temporaryDirectory()
        try TalariaShareDraft.savePendingDraft("Keep me", in: directory)
        let attachmentSize = TalariaShareDraft.maximumSharedImportBytes / 2 + 1
        let oversizedTotal = ["first.bin", "second.bin"].map {
            SharedAttachmentImport(filename: $0, typeIdentifier: nil, data: Data(count: attachmentSize))
        }

        XCTAssertThrowsError(
            try TalariaShareDraft.savePendingImport(
                draft: "Replacement",
                attachments: oversizedTotal,
                in: directory
            )
        ) { error in
            XCTAssertEqual(
                error as? SharedDraftStoreError,
                .totalAttachmentBytesExceeded(maximumBytes: TalariaShareDraft.maximumSharedImportBytes)
            )
        }

        XCTAssertEqual(try TalariaShareDraft.loadPendingDraft(from: directory), "Keep me")
    }

    func testLegacyImportRejectsAggregateOverflowWithoutDeletingStagedFiles() throws {
        let directory = try temporaryDirectory()
        let attachmentsDirectory = directory.appendingPathComponent(
            TalariaShareDraft.pendingAttachmentsDirectoryName,
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: attachmentsDirectory, withIntermediateDirectories: true)

        let attachmentSize = TalariaShareDraft.maximumSharedImportBytes / 2 + 1
        let attachments = ["first.bin", "second.bin"]
        for filename in attachments {
            try Data(count: attachmentSize).write(to: attachmentsDirectory.appendingPathComponent(filename))
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
        let payloadURL = directory.appendingPathComponent(TalariaShareDraft.pendingDraftFileName)
        try JSONEncoder().encode(payload).write(to: payloadURL)

        XCTAssertThrowsError(try TalariaShareDraft.reserveNextPendingImport(from: directory)) { error in
            XCTAssertEqual(
                error as? SharedDraftStoreError,
                .totalAttachmentBytesExceeded(maximumBytes: TalariaShareDraft.maximumSharedImportBytes)
            )
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: payloadURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: attachmentsDirectory.path))
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Leaked directories accumulate on shared pool simulators (TAL-145).
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func attachmentFileURLs(in directory: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey]
        ) else {
            return []
        }

        return enumerator.compactMap { element in
            guard
                let url = element as? URL,
                url.pathExtension != "json",
                (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            else {
                return nil
            }
            return url
        }
    }
}
