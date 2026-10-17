import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The fixture chat's transcript rows, hosted in process against the UI fixture's scenarios (TAL-856): what each row
/// says to VoiceOver, its button trait, and where it sits against its neighbours.
@MainActor
final class TranscriptHostedTests: XCTestCase {
    func testFastUpwardScrollingKeepsLoadingWithoutLeavingThePrefetchRegion() async throws {
        var requested: [Int] = []
        let window = try hostWindow(PagedHistoryTranscript(sparseOlderPages: true) { requested.append($0) })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        try await Task.sleep(for: .milliseconds(150))
        // A fast reader repeatedly reaches the loaded edge while a prepend is settling.
        for _ in 0..<150 {
            scroll.contentOffset.y = -scroll.adjustedContentInset.top
            try await Task.sleep(for: .milliseconds(10))
        }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertGreaterThanOrEqual(requested.count, 3, "Fast scrolling must keep requesting older pages without an away/back gesture")
        let pages = Array(stride(from: 1_950, through: 50, by: -50))
        XCTAssertEqual(requested, Array(pages.prefix(requested.count)), "Every cursor is requested once; never request past the first page")
        attachHistoryImage(window, name: "Fast upward history after prefetch")
    }

    func testHistoryPrefetchStartsBeforeTheLastViewport() async throws {
        var requests = 0
        let window = try hostWindow(historyTranscript(messageCount: 100) { _ in requests += 1; return false })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        try await Task.sleep(for: .milliseconds(150))
        let viewportHeight = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        scroll.contentOffset.y = viewportHeight * 3 - scroll.adjustedContentInset.top
        for _ in 0..<20 where requests == 0 { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertEqual(requests, 1, "Prefetch must start with three viewports of history still available")
    }

    func testHistoryResponsePreservesWhereTheReaderMovedWhilePageWasInFlight() async throws {
        var requested: [Int] = []
        let window = try hostWindow(PagedHistoryTranscript(responseDelay: .milliseconds(150)) { requested.append($0) })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        scroll.contentOffset.y = 100
        for _ in 0..<30 where requested.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(requested, [1950])
        scroll.contentOffset.y = 300
        let label = "History row 1956. Synthetic transcript text."
        let before = try await requireElement(in: window, label: label).accessibilityFrame.minY
        _ = try await requireElement(in: window, label: "History row 1900. Synthetic transcript text.")
        try await Task.sleep(for: .milliseconds(100))
        let after = try await requireElement(in: window, label: label).accessibilityFrame.minY
        XCTAssertEqual(after, before, accuracy: 2, "A response must preserve the reader's latest position, not jump back to the request's position")
    }

    func testScrollingNearTheTopLoadsHistoryWithoutATap() async throws {
        var requests = 0
        var finish: ((Bool) -> Void)?
        let window = try hostWindow(NavigationStack {
            historyTranscript { _ in
                requests += 1
                return await withCheckedContinuation { continuation in
                    finish = { result in finish = nil; continuation.resume(returning: result) }
                }
            }
            .navigationTitle("Transcript history")
        })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(requests, 0, "Opening at the latest row must not page history")
        scroll.contentOffset.y = 100
        for _ in 0..<30 where requests == 0 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 1, "The top sentinel must request history before the reader reaches the top")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Load older messages"))
        for _ in 0..<5 { scroll.contentOffset.y = 100; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(requests, 1, "Repeated appearances must not overlap requests")
        scroll.contentOffset.y = -scroll.adjustedContentInset.top
        try await Task.sleep(for: .milliseconds(250))
        attachHistoryImage(window, name: "History loading")
        finish?(false)
        let retry = await awaitElement(in: window, label: "Try Again", timeout: 2)
        XCTAssertNotNil(retry, "Failed history must offer inline retry")
        try await Task.sleep(for: .milliseconds(250))
        attachHistoryImage(window, name: "History retry")
        scroll.contentOffset.y = 1_000
        scroll.contentOffset.y = 0
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(requests, 1, "Failed history must stop automatic requests")
        if let retry { HostedAccessibility.activate(retry) }
        for _ in 0..<20 where requests < 2 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 2)
        finish?(true)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(requests, 2, "One appearance must not chain pages")
    }

    func testContinuousHistoryLoadsAllTwoThousandRowsAndPreservesPosition() async throws {
        var requested: [Int] = []
        let window = try hostWindow(PagedHistoryTranscript { requested.append($0) })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        try await Task.sleep(for: .milliseconds(150))
        let pages = Array(stride(from: 1_950, through: 50, by: -50))
        // A larger prefetch buffer can load several pages before the next gesture.
        for _ in pages where requested.count < pages.count {
            let start = (requested.last ?? 2_000) - 50
            let previousCount = requested.count
            scroll.contentOffset.y = 100
            let label = "History row \(start + 3). Synthetic transcript text."
            let before = try await requireElement(in: window, label: label).accessibilityFrame.minY
            for _ in 0..<40 where requested.count == previousCount { try await Task.sleep(for: .milliseconds(25)) }
            XCTAssertEqual(requested.dropFirst(previousCount).first, start)
            try await Task.sleep(for: .milliseconds(100))
            let after = try await requireElement(in: window, label: label).accessibilityFrame.minY
            XCTAssertEqual(after, before, accuracy: 2, "Prepending a page moved the reader at offset \(start)")
            // Programmatic UIKit offsets have no drag to release the controller's existing one-second prepend window.
            try await Task.sleep(for: .milliseconds(1_050))
            XCTAssertEqual(requested, Array(pages.prefix(requested.count)), "Prefetch bursts must keep every cursor ordered and unique")
            let settled = try await requireElement(in: window, label: label).accessibilityFrame.minY
            XCTAssertEqual(settled, before, accuracy: 2)
        }
        XCTAssertEqual(requested, pages)
        scroll.contentOffset.y = 0
        _ = try await requireElement(in: window, label: "History row 0. Synthetic transcript text.")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Load older messages"))
    }

    func testANewTopAppearanceDuringLoadingRunsAfterThePageSettles() async throws {
        var requests = 0
        var finish: ((Bool) -> Void)?
        let window = try hostWindow(historyTranscript { _ in
            requests += 1
            return await withCheckedContinuation { continuation in
                finish = { result in finish = nil; continuation.resume(returning: result) }
            }
        })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        scroll.contentOffset.y = 100
        for _ in 0..<30 where requests == 0 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 1)
        scroll.contentOffset.y = scroll.contentSize.height - scroll.bounds.height
        try await Task.sleep(for: .milliseconds(100))
        scroll.contentOffset.y = 0
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(requests, 1, "A repeated appearance must not overlap a page")
        finish?(true)
        for _ in 0..<40 where requests < 2 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 2, "A new appearance while loading must not strand the reader at the top")
        finish?(false)
    }

    private func historyScroll(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        return view.subviews.lazy.compactMap { self.historyScroll(in: $0) }.first
    }

    func testPrependPreservesPositionWithAnExpandedDisclosure() async throws {
        var requested: [Int] = []
        let window = try hostWindow(PagedHistoryTranscript(hasDisclosure: true) { requested.append($0) })
        let scroll = try XCTUnwrap(historyScroll(in: window))
        let showMore = try await requireElement(in: window, label: "Show more")
        HostedAccessibility.activate(showMore)
        _ = try await requireElement(in: window, label: "Show less")
        scroll.contentOffset.y = 100
        let label = "History row 1953. Synthetic transcript text."
        let before = try await requireElement(in: window, label: label).accessibilityFrame.minY
        let beforeOffset = scroll.contentOffset.y
        let beforeHeight = scroll.contentSize.height
        for _ in 0..<40 where requested.isEmpty { try await Task.sleep(for: .milliseconds(25)) }
        try await Task.sleep(for: .milliseconds(150))
        let after = try await requireElement(in: window, label: label).accessibilityFrame.minY
        XCTAssertEqual(requested.first, 1950)
        let pages = Array(stride(from: 1_950, through: 50, by: -50))
        XCTAssertEqual(requested, Array(pages.prefix(requested.count)))
        XCTAssertEqual(after, before, accuracy: 2, "Prepend cursors \(requested); offset \(beforeOffset) → \(scroll.contentOffset.y); height \(beforeHeight) → \(scroll.contentSize.height)")
    }

    private func attachHistoryImage(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }


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
private func historyTranscript(messages supplied: [ChatMessage]? = nil, messageCount: Int = 50, messageOffset: Int? = nil, hasOlderMessages: Bool = true, load: @escaping (@MainActor () -> Void) async -> Bool) -> some View {
    let messages = supplied ?? (0..<messageCount).map { index in
        ChatMessage(role: "user", content: "History row \(index). Synthetic transcript text.", timestamp: nil, messageId: "history-\(index)")
    }
    return ChatTranscriptView(
        isLoading: false, errorMessage: nil, messages: messages,
        displayedTranscriptMessages: ChatViewModel.transcriptMessages(from: messages, messageOffset: messageOffset),
        compressionReferenceCard: nil, branchedFrom: nil, reasoningGroups: [],
        completedToolCallGroupsForAnchor: { _ in [] }, archivedActivityRowsForAnchor: { _ in [] },
        earlierSceneRowsForTurn: { _ in [] }, onLoadEarlierSceneRows: { _ in },
        liveReasoningText: "", liveActivityRows: [], reasoningAnchorMessageID: nil,
        liveToolCalls: [], toolCallAnchorMessageID: nil, streamingAssistantMessageID: nil,
        liveTokensPerSecond: nil, showsRunStateCheck: false, clarificationPrompt: nil,
        showsThinkingAndToolCards: false, shouldFollowLatestMessage: false,
        isDisclosureSettling: false, latestTranscriptMessageRole: nil, isScrolledNearBottom: false,
        activeStreamID: nil, streamingScrollTrigger: 0, cacheFirstReconcileScrollToken: 0,
        bottomAnchorID: "bottom", transcriptMessageSpacing: 12, transcriptBlockSpacing: 8,
        transcriptBottomInsetHeight: 0, scrollToBottomRequest: 0, followReplayRequest: 0,
        assistantName: "Assistant", localAttachmentPreviews: [:], listeningMessageID: nil,
        isViewingCachedData: false, isSessionReadOnly: false, canBranch: false,
        hasOlderMessages: hasOlderMessages, isLoadingOlderMessages: false,
        isRegeneratingMessage: false, isEditingMessage: false, isForkingMessage: false,
        loadAttachmentImage: { _ in nil }, loadAttachmentData: { _ in nil },
        loadTranscriptMediaImage: { _ in nil }, loadTranscriptMediaData: { _ in nil },
        transcriptMediaCacheNamespace: "history-test", actionContext: { _, _ in nil },
        shouldRenderMessageRow: { _ in true }, onLoadMessages: {}, onLoadOlderMessages: load,
        onUpdateScrollMetrics: { _ in }, onFollowEvent: { _ in }, onDisclosureToggle: {},
        onFollowSuppressed: {}, onDismissKeyboard: {}, onScrollToBottom: { _ in },
        onScrollToLatestTranscriptMessage: { _ in }, onScrollToLatestContent: { _, _ in },
        onPreviewAttachment: { _, _ in }, onPreviewTranscriptMedia: { _ in },
        onToggleListening: { _ in }, onSelectText: { _ in }, onRegenerate: { _ in },
        onEdit: { _ in }, onFork: { _ in }, onCopy: { _ in }
    )
}

/// Hosts the transcript directly because FixtureApp's canned session does not page.
@MainActor
private struct PagedHistoryTranscript: View {
    @State private var start = 1_950
    var hasDisclosure = false
    var sparseOlderPages = false
    var responseDelay = Duration.zero
    let onRequest: (Int) -> Void

    var body: some View {
        let messages = (start..<2_000).map { index in
            if hasDisclosure && index == 1993 {
                return ChatMessage(role: "user", content: String(repeating: "Expanded history fixture.\n", count: 30), timestamp: nil, messageId: "history-\(index)", displayExcerpt: "Expanded history fixture.", collapsible: true)
            }
            return ChatMessage(role: "user", content: "History row \(index). Synthetic transcript text.", timestamp: nil, messageId: "history-\(index)", display: sparseOlderPages && index < 1_950 && index % 50 != 0 ? .hidden : .row)
        }
        historyTranscript(messages: messages, messageOffset: start, hasOlderMessages: start > 0) { beforePrepend in
            onRequest(start)
            try? await Task.sleep(for: responseDelay)
            beforePrepend()
            start = max(0, start - 50)
            return true
        }
    }
}
