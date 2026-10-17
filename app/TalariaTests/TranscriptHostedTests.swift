import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The fixture chat's transcript rows, hosted in process against the UI fixture's scenarios (TAL-856): what each row
/// says to VoiceOver, its button trait, and where it sits against its neighbours.
@MainActor
final class TranscriptHostedTests: XCTestCase {
    /// A server wakeup renders as completion lines above its reply; a silent reply stays hidden and a typed marker
    /// stays the user's message (TAL-371).
    func testWakeupsRenderAsCompletionLinesWithTheirReplies() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let found = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "background-update-lines" }
        let batch = try XCTUnwrap(found, "The wakeup did not render as completion lines")
        let updates = HostedAccessibility.elements(in: window).filter {
            HostedAccessibility.identifier(of: $0) == "background-update-lines"
        }
        XCTAssertEqual(batch.accessibilityLabel, "Audit the fixture. The parent reviewed this result., make test. The worker or parent review failed. Parent review: The parent reviewed this result.")
        XCTAssertEqual(updates.dropFirst().first?.accessibilityLabel, "./backup.sh. The parent reviewed this result.")
        XCTAssertTrue(updates.contains { $0.accessibilityLabel == "Waiting result. Waiting for the parent to review this result., Active review. The parent is reviewing this result., Unknown result. The worker or parent review outcome is unknown." })
        let reply = try await requireElement(in: window, label: "The audit finished and the test run failed.")
        XCTAssertLessThan(batch.accessibilityFrame.maxY, reply.accessibilityFrame.minY, "The reply is not under its completion lines")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "[SILENT]"), "A silent background reply is shown")
        XCTAssertNotNil(
            HostedAccessibility.element(in: window, label: "[ASYNC DELEGATION BATCH COMPLETE — typed] I typed this"),
            "The typed marker is no longer the user's message"
        )

        HostedAccessibility.activate(batch)
        let body = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Delegated result body.") == true }
        XCTAssertNotNil(body, "The expanded update does not show the full notification")
    }

    func testLegacyBackgroundFailuresKeepTheirWarningWithoutInventingParentReview() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let expected = "Legacy failed goal. The worker or parent review failed., Legacy completed goal. The worker or parent review outcome is unknown."
        let row = await awaitElement(in: window, label: expected)
        XCTAssertNotNil(row, "An older server's known failure must remain a warning, while its success proves no parent review")
    }

    func testBackgroundReviewUsesTheAgreedPlatformIcons() {
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.waiting), "clock")
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.reviewed), "checkmark")
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.failed), "exclamationmark.triangle.fill")
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.unknown), "questionmark.circle")
        XCTAssertEqual(BackgroundWorkSheet.icon(nil as BackgroundReviewState?), "questionmark.circle")
    }

    /// The compaction card follows the row the server named and precedes the next one (TAL-560).
    func testTheReferenceCardFollowsTheServersNamedRow() async throws {
        let window = try await hostFixtureChat(["--ui-test-compression-reference"])
        let found = await awaitElement(in: window) {
            $0.accessibilityLabel?.contains("Reference only · Earlier turns were summarised.") == true
        }
        let card = try XCTUnwrap(found, "The reference card is missing")
        let anchor = try await requireElement(in: window, label: "Here is the plan.")
        let next = try await requireElement(in: window, label: "Start step one.")
        XCTAssertLessThan(anchor.accessibilityFrame.maxY, card.accessibilityFrame.minY, "The card is not after the named row")
        XCTAssertLessThan(card.accessibilityFrame.maxY, next.accessibilityFrame.minY, "The card is not before the following row")
    }

    /// A branch links back to the chat it came from as one button, and that parent shows no such link (TAL-454). The
    /// link's session URL and its routing are unit tests (`LiveActivityTests`, `SessionListOpenTests`).
    func testTheBranchShowsItsParentLinkAndTheParentShowsNone() async throws {
        let branch = try await hostFixtureChat(["--ui-test-branched-from"])
        let branchReply = await awaitElement(in: branch, label: "Branched fixture reply")
        XCTAssertNotNil(branchReply, "The branch transcript is missing")
        let link = try await requireElement(in: branch, label: "Branched from Fixture Session 01", "The branch row is missing")
        XCTAssertTrue(link.accessibilityTraits.contains(.button), "VoiceOver does not read the branch row as a button")
        branch.isHidden = true

        let parent = try await hostFixtureChat(["--ui-test-branched-from"], sessionID: "ui-fixture-session-1")
        let parentReply = await awaitElement(in: parent, label: "Parent fixture reply")
        XCTAssertNotNil(parentReply, "The parent transcript is missing")
        XCTAssertNil(HostedAccessibility.element(in: parent, label: "Branched from Fixture Session 01"), "The parent chat shows a branch row")
    }

    /// Only the server's collapsible prompt folds; Show more shows it whole and Show less returns it to its fold (TAL-452).
    func testLongPromptOpensFoldedAndToggles() async throws {
        let window = try await hostFixtureChat(["--ui-test-long-prompt"])
        let isPrompt: (NSObject) -> Bool = { $0.accessibilityLabel?.hasPrefix("Fixture prompt line 1\n") == true }
        let rendered = await awaitElement(in: window, where: isPrompt)
        XCTAssertNotNil(rendered, "The long prompt did not render")
        let showMore = try await requireElement(in: window, label: "Show more", "The long prompt did not open folded")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == "Show more" }.count, 1, "Only the long prompt folds")
        func promptHeight() throws -> CGFloat {
            try XCTUnwrap(HostedAccessibility.elements(in: window).first(where: isPrompt)).accessibilityFrame.height
        }
        let folded = try promptHeight()

        HostedAccessibility.activate(showMore)
        let showLess = try await requireElement(in: window, label: "Show less", "The folded prompt did not expand")
        // 24 lines against a fold of 8.
        XCTAssertGreaterThan(try promptHeight(), folded * 2, "The expanded prompt is not shown whole")

        HostedAccessibility.activate(showLess)
        let refolded = await awaitElement(in: window, label: "Show more")
        XCTAssertNotNil(refolded, "The expanded prompt did not fold again")
        XCTAssertEqual(try promptHeight(), folded, accuracy: 2, "The prompt did not return to its fold")
    }

    /// `diff` and `patch` blocks announce added and removed lines in light and dark; `log` and `text` blocks with the same
    /// prefixes, and a file header, stay plain (TAL-447).
    func testDiffAndPatchBlocksMarkChangedLinesInLightAndDark() async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let window = try await hostFixtureChat(["--ui-test-diff-blocks"]) { $0.userInterfaceStyle = style }
            for label in [
                "Removed: -let fixtureRemoved = 1",
                "Added: +let fixtureAdded = 2",
                "Added: +",
                "Removed: -patch fixture removed",
                "Added: +patch fixture added"
            ] {
                let line = await awaitElement(in: window, label: label)
                XCTAssertNotNil(line, "Missing \(label) in \(style)")
            }
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "+log fixture line"), "The log block lost its line")
            for plain in ["Added: +log fixture line", "Added: +text fixture line", "Added: +++ b/Fixture.swift"] {
                XCTAssertNil(HostedAccessibility.element(in: window, label: plain), "\(plain) was announced as a change")
            }
            window.isHidden = true
        }
    }
}

@MainActor
extension TranscriptHostedTests {
    func testPendingPhotoFileAndVoicePresentationAtPhoneAndPadWidths() async throws {
        let bytes = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
        }
        let audio = silentWave()
        let photo = PendingAttachment(name: "Photo.png", path: "local-photo", mime: "image/png", isImage: true,
                                      thumbnailData: bytes, uploadPhase: .uploading)
        let file = PendingAttachment(name: "Notes.txt", path: "local-file", mime: "text/plain", isImage: false,
                                     uploadPhase: .failed("Upload failed. Try again."))
        var voice = ChatMessage(role: "user", content: "", timestamp: 1, messageId: "local-voice",
                                attachments: [MessageAttachment(name: "Voice.wav", path: "local-voice", mime: "audio/wav")])
        voice.localVoicePhase = .preparing
        for size in [HostedSize.phone, HostedSize.padLandscape] {
            let before = try hostWindow(
                VStack { Spacer(); TextField("Message", text: .constant("New typed draft")) }
                    .padding(20).background(Color(.systemBackground)), size: size
            )
            attachMediaEvidence(before, name: size == HostedSize.phone ? "before-local-media-phone" : "before-local-media-pad")
            before.isHidden = true
            var retries = 0
            let window = try hostWindow(
                VStack(spacing: 16) {
                    MessageBubbleView(message: voice, loadAttachmentData: { _ in audio })
                    Spacer()
                    ComposerAttachmentStripView(photos: [photo], onRemove: { _ in }, onPreview: { _ in })
                    ComposerFileLinkView(attachment: file, onRemove: {}, onOpen: {})
                    TextField("Message", text: .constant("New typed draft"))
                }
                .padding(20)
                .background(Color(.systemBackground))
                .environment(\.retryPendingAttachment, { _ in retries += 1 }),
                size: size
            )
            let uploading = await awaitElement(in: window, label: "Uploading Photo.png")
            XCTAssertNotNil(uploading, "Missing upload state: \(HostedAccessibility.labels(in: window))")
            let retry = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Retry upload Notes.txt"))
            HostedAccessibility.activate(retry)
            XCTAssertEqual(retries, 1)
            let preparing = await awaitElement(in: window, label: "Preparing voice note")
            XCTAssertNotNil(preparing)
            let play = await awaitElement(in: window, label: "Play Voice.wav")
            _ = try XCTUnwrap(play, "The local voice note must be replayable during preparation")
            attachMediaEvidence(window, name: size == HostedSize.phone ? "local-media-phone" : "local-media-pad")
            window.isHidden = true
        }
    }

    private func attachMediaEvidence(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let evidence = XCTAttachment(image: image)
        evidence.name = name
        evidence.lifetime = .keepAlways
        add(evidence)
    }


    private func silentWave() -> Data {
        var data = Data()
        func number<T: FixedWidthInteger>(_ value: T) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(Data("RIFF".utf8))
        number(UInt32(36 + 16_000))
        data.append(Data("WAVEfmt ".utf8))
        number(UInt32(16))
        number(UInt16(1))
        number(UInt16(1))
        number(UInt32(8_000))
        number(UInt32(16_000))
        number(UInt16(2))
        number(UInt16(16))
        data.append(Data("data".utf8))
        number(UInt32(16_000))
        data.append(Data(count: 16_000))
        return data
    }

}
