import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// The fixture chat's media, long bodies, background work and pending steers, hosted in process (TAL-856).
@MainActor
final class ChatHostedTests: XCTestCase {
    func testStreamingSendConsumesDraftWhileSteerIsHeldAndPreservesNewTyping() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-controls", "--ui-test-hold-steer"], for: self)
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("Held steering prompt", in: window)
        _ = try await requireElement(in: window, label: "Held steering prompt")
        let composer = await composerTextView(in: window)
        let draft = try XCTUnwrap(composer)
        XCTAssertEqual(draft.text, "", "A streaming send must consume its draft before the steer answers")
        let screenshot = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        screenshot.name = "streaming-send-pending-phone"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        try await typeIntoComposer("Newer draft", in: window)
        fixture.releaseHeldLoads()
        let waiting = await awaitElement(in: window, label: "Held steering prompt")
        XCTAssertNotNil(waiting)
        XCTAssertEqual(draft.text, "Newer draft")
    }

    func testSyncingBesideGoalDoesNotReserveTranscriptSpaceInNarrowStack() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads", "--ui-test-goal"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(fixture.chat(session), size: CGSize(width: 320, height: 844))
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Fixture message 1 ") == true }
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Goal parked") == true }
        NotificationCenter.default.post(name: .talariaReauthenticated, object: UITestFixtureEnvironment.serverURL)
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        settle(0.3)
        let scroll = try transcriptScrollView(in: window)
        let withSyncing = scroll.adjustedContentInset.bottom
        fixture.releaseHeldLoads()
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(cleared)
        settle(0.3)
        XCTAssertEqual(scroll.adjustedContentInset.bottom, withSyncing, accuracy: 1,
                       "The non-reserving syncing segment changed the transcript inset beside a goal")
    }

    func testWorkingAndQueueShareOneRowWithIndependentActions() async throws {
        continueAfterFailure = false
        let window = try await hostFixtureChat(["--ui-test-chat-controls"])
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("/queue First queued message", in: window)
        try await sendFromComposer("/queue Second queued message", in: window)
        let queue = try await requireElement(in: window, label: "2 queued")
        let status = try await requireElement(in: window) { $0.accessibilityLabel?.hasSuffix("is working on the response") == true }
        settle(0.3)
        let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        attachment.name = "working-queue-phone"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertEqual(status.accessibilityFrame.midY, queue.accessibilityFrame.midY, accuracy: 1,
                       "Working and the queue must be segments of one row")
        XCTAssertLessThan(status.accessibilityFrame.maxX, queue.accessibilityFrame.minX)
        XCTAssertFalse(status.accessibilityTraits.contains(.button))
        XCTAssertTrue(queue.accessibilityTraits.contains(.button))
        XCTAssertGreaterThanOrEqual(queue.accessibilityFrame.height, 44)
        HostedAccessibility.activate(status)
        XCTAssertNil(window.rootViewController?.presentedViewController)
        HostedAccessibility.activate(queue)
        _ = try await requireElement(in: window, label: "First queued message")
        _ = try await requireElement(in: window, label: "Second queued message")
        for remaining in [1, 0] {
            let remove = try XCTUnwrap(elements(named: "Remove", in: window).first {
                $0.accessibilityTraits.contains(.button) && $0.accessibilityFrame.height > 0
                    && window.bounds.contains(window.convert($0.accessibilityFrame, from: nil))
            }, "The queue has no visible Remove button")
            XCTAssertTrue(HostedAccessibility.activate(remove))
            if remaining == 1 {
                // List retains removed rows in its hosted AX cache. Observe the live count and
                // reopen the sheet before targeting its remaining row.
                _ = try await requireElement(in: window, label: "1 queued")
                HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
            }
            let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
            XCTAssertTrue(closed)
            if remaining == 1 {
                HostedAccessibility.activate(try await requireElement(in: window, label: "1 queued"))
                _ = try await requireElement(in: window, label: "Second queued message")
            }
        }
        let drained = await awaitNoElement(in: window) { $0.accessibilityLabel == "1 queued" || $0.accessibilityLabel == "2 queued" }
        XCTAssertTrue(drained)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasSuffix("is working on the response") == true }
        try await sendFromComposer("/queue Re-added message", in: window)
        _ = try await requireElement(in: window, label: "1 queued")
    }

    /// Server-rewritten media renders inside the Markdown around it, audio follows as a tile, and its Export opens the
    /// file exporter (TAL-186). Saving through the exporter is the phone check's.
    func testServerMediaRendersInsideTheMarkdownAroundIt() async throws {
        let window = try await hostFixtureChat(["--ui-test-transcript-media"])
        _ = try await requireElement(in: window, label: "Linked chart", "The linked image did not render as a thumbnail")
        // Thumbnails show a spinner until their bytes load, then the image in its 132-point box or, on failure, a
        // shorter unavailable chip under the same alt-text name.
        // Every spinner counts, the audio tile's too, and a hosted CI simulator can take well over 10 s to start audio.
        let loaded = await awaitCondition(timeout: 30) { !window.containsView(ofType: UIActivityIndicatorView.self) }
        XCTAssertTrue(loaded, "The thumbnails never finished loading")
        for name in ["Linked chart", "chart.png", "Chart"] {
            let thumbnail = try XCTUnwrap(elements(named: name, in: window).first, "Missing the \(name) thumbnail")
            XCTAssertEqual(thumbnail.accessibilityFrame.height, 132, accuracy: 1, "The \(name) thumbnail shows no image")
        }
        let labels = HostedAccessibility.labels(in: window)
        XCTAssertTrue(labels.contains { $0.contains("narration.mp3") }, "The audio file did not render as a tile")
        XCTAssertFalse(labels.contains { $0.contains("**") }, "Bold text around an image rendered literally")
        XCTAssertFalse(labels.contains { $0.contains("MEDIA:") }, "A media token rendered as text")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Export audio narration.mp3"))
        let exporter = await presentedController(in: window)
        XCTAssertTrue(exporter is UIDocumentPickerViewController, "The audio's Export did not open the file exporter")
        exporter?.dismiss(animated: false)
    }

    /// Very long bodies open collapsed to the server's excerpts and expand and collapse in place (TAL-456).
    func testLongBodiesOpenCollapsedAndExpandInPlace() async throws {
        let window = try await hostFixtureChat(["--ui-test-long-bodies"])
        _ = try await requireElement(in: window, label: "Show more", "A long body did not open collapsed")
        let showMore = try XCTUnwrap(elements(named: "Show more", in: window).last)
        XCTAssertEqual(try messageMenuTarget(at: showMore, in: window), .control, "A long press on Show more opens the message menu")
        HostedAccessibility.activate(showMore)
        let showLess = try await requireElement(in: window, label: "Show less", "The collapsed body did not expand")
        HostedAccessibility.activate(showLess)
        let collapsed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Show less" }
        XCTAssertTrue(collapsed, "The expanded body did not collapse again")
        // An unfocused composer is its collapsed "Message" shell.
        let composer = await awaitElement(in: window, label: "Message")
        XCTAssertNotNil(composer, "The composer went away")
    }

    /// Background work shows as one count chip above the composer (TAL-1001); its sheet lists the server's records, a
    /// delegation its subagents' progress, the full result on request, and a Dismiss that removes only finished work
    /// (TAL-372).
    func testBackgroundWorkChipOpensTheServersRecordsWithResultAndDismiss() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let containing: (String) -> (NSObject) -> Bool = { text in { $0.accessibilityLabel?.contains(text) == true } }
        // A sheet row reads its title with its kind and status; the transcript names the same work in its own rows.
        let finishedRow: (NSObject) -> Bool = { containing("Summarize the repo")($0) && containing("Background task · ")($0) }
        let chip = await awaitElement(in: window, where: containing("Background tasks · 2"))
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains(where: finishedRow), "A task row shows outside the sheet")

        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Worked", in: window).first, "The delegation row has no Worked disclosure"))
        let progress = await awaitElement(in: window, where: containing("2 of 3 done · 1 failed"))
        XCTAssertNotNil(progress, "The delegation row does not show its subagents' progress")

        HostedAccessibility.activate(try XCTUnwrap(chip, "The background tasks chip is missing"))
        let running = await awaitElement(in: window, where: containing("Fix CI"))
        XCTAssertNotNil(running, "The running delegation is missing from the sheet")
        let finished = try XCTUnwrap(
            HostedAccessibility.elements(in: window).first(where: finishedRow),
            "The finished /background task is missing from the sheet"
        )

        HostedAccessibility.activate(finished)
        _ = try await requireElement(in: window, label: "The repo has three packages.", "The full result did not load")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Dismiss"))
        let dismissed = await awaitNoElement(in: window, where: finishedRow)
        XCTAssertTrue(dismissed, "Dismiss left the finished task in the sheet")
        let remaining = await awaitElement(in: window) { containing("Fix CI")($0) && containing("Agent · ")($0) }
        XCTAssertNotNil(remaining, "Dismiss removed running work")
    }

    /// The session's standing `/goal` shows as one chip above the composer, worded from the server's field (TAL-833).
    func testTheStandingGoalShowsAboveTheComposer() async throws {
        let window = try await hostFixtureChat(["--ui-test-goal"])
        let chip = await awaitElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Goal parked · 5/20 turns · until ") == true
                && $0.accessibilityLabel?.hasSuffix(" · CI running · Ship the release notes") == true
        }
        XCTAssertNotNil(chip, "The parked goal chip is missing")
    }

    /// Steers pending from another device offer only the actions the server allows; Send now explains a live
    /// requeue, and Edit appends the steer after the draft (TAL-300, TAL-1000).
    func testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers"])
        try await sendFromComposer("Back up the cluster", in: window)

        _ = try await requireElement(in: window, label: "Check the backup logs too", "The pending steer from Web is missing")
        _ = try await requireElement(in: window, label: "Skip the cache", "The second pending steer is missing")
        let waiting = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Waiting for agent") == true }
        XCTAssertNotNil(waiting)
        // Only the actions the server allows: the second steer offers no Send now.
        XCTAssertEqual(elements(named: "Send now", in: window).count, 1)
        XCTAssertEqual(elements(named: "Edit steering message", in: window).count, 2)
        XCTAssertEqual(elements(named: "Cancel steering message", in: window).count, 2)

        // TAL-1001: Send now explains itself in one short chip, however often it is tapped, that goes on its own.
        let isNotice: (NSObject) -> Bool = { $0.accessibilityLabel == "The agent takes it at its next step." }
        for _ in 0..<5 {
            HostedAccessibility.activate(try XCTUnwrap(elements(named: "Send now", in: window).first))
            _ = await awaitElement(in: window, where: isNotice)
        }
        let notice = await awaitElement(in: window, where: isNotice)
        XCTAssertNotNil(notice, "Send now did not explain the live requeue")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter(isNotice).count, 1, "Repeated Send now stacked notices")
        XCTAssertEqual(notice?.accessibilityValue, "Information", "The notice does not say its kind")
        let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        attachment.name = "send-now-phone"
        attachment.lifetime = .keepAlways
        add(attachment)
        let dismissed = await awaitNoElement(in: window, timeout: 5, where: isNotice)
        XCTAssertTrue(dismissed, "The notice never went away on its own")

        // Edit appends the steer after the draft, a blank line between.
        try await typeIntoComposer("Draft", in: window)
        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Edit steering message", in: window).first))
        let edited = await awaitNoElement(in: window) { $0.accessibilityLabel == "Check the backup logs too" }
        XCTAssertTrue(edited, "The edited steer is still pending")
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, "Draft\n\nCheck the backup logs too")
    }

    /// Active approval bypass shows as a 44-point chip that asks before turning bypass off; Cancel keeps it, and it
    /// leaves once the server confirms (TAL-664).
    func testApprovalBypassChipTurnsBypassOffForTheSession() async throws {
        let window = try await hostFixtureChat(["--ui-test-approval-bypass"])
        let isChip: (NSObject) -> Bool = { $0.accessibilityLabel == "Approval bypass active" }
        let chip = try await requireElement(in: window, "The fixture never showed active bypass", where: isChip)
        XCTAssertTrue(chip.accessibilityTraits.contains(.button), "The bypass status is not an actionable button")
        XCTAssertGreaterThanOrEqual(chip.accessibilityFrame.height, 44)
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The chip is off screen")

        HostedAccessibility.activate(chip)
        let asked = await presentedAlert(in: window)
        let cancelled = try XCTUnwrap(asked, "Tapping the chip did not ask before changing bypass")
        XCTAssertEqual(cancelled.title, "Turn off approval bypass")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: cancelled))
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed, "Cancel left the confirmation up")
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isChip), "Cancel turned bypass off")

        HostedAccessibility.activate(try await requireElement(in: window, where: isChip))
        let confirmed = await presentedAlert(in: window)
        XCTAssertTrue(HostedAccessibility.tap("Turn off approval bypass", in: try XCTUnwrap(confirmed)))
        let removed = await awaitNoElement(in: window, where: isChip)
        XCTAssertTrue(removed, "A server-confirmed disabled bypass left the chip")
    }

    /// The Agent's notices show as chips above the composer with the server's text, and Dismiss hides one (TAL-831).
    func testTheAgentsNoticesShowAboveTheComposerAndDismiss() async throws {
        let window = try await hostFixtureChat(["--ui-test-session-notices"])
        let warning = "Memory provider 'honcho' could not be loaded; memory is off."
        let chip = try await requireElement(in: window, label: warning, "The Agent's warning is not above the composer")
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The warning is off screen")
        _ = try await requireElement(in: window, label: "You've used 90% of your credits.", "The Agent's credit notice is missing")

        let dismissals = elements(named: "Dismiss notice", in: window)
        XCTAssertEqual(dismissals.count, 2, "Each notice needs its own Dismiss")
        HostedAccessibility.activate(try XCTUnwrap(dismissals.first))
        let dismissed = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(dismissed, "Dismiss left the warning up")
        let kept = await awaitElement(in: window, label: "You've used 90% of your credits.")
        XCTAssertNotNil(kept, "Dismiss hid the other notice")
    }

    /// The Agent's notices arrive on the stream, and the one the Agent clears leaves its chip (TAL-831).
    func testANoticeTheServerClearsLeavesItsChip() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers", "--ui-test-session-notices"])
        try await sendFromComposer("Back up the cluster", in: window)
        let warning = "Memory provider 'honcho' could not be loaded; memory is off."
        _ = try await requireElement(in: window, label: warning, "The stream's warning is not above the composer")
        // The fixture's Agent clears its warning after the steer's edit.
        HostedAccessibility.activate(try await requireElement(in: window, label: "Edit steering message"))
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(cleared, "The warning the server cleared is still up")
        let kept = await awaitElement(in: window, label: "You've used 90% of your credits.")
        XCTAssertNotNil(kept, "The clear hid the notice the server kept")
    }

    /// A manual /compress shows in the run status chip, timed from the server's job start, leaves the composer's
    /// placeholder alone, and clears its draft as it starts (TAL-1006).
    func testManualCompressionShowsInTheRunStatusChip() async throws {
        let window = try await hostFixtureChat()
        try await sendFromComposer("/compress", in: window)
        // The chip shows as the command is sent; its elapsed time follows once the server's job start arrives.
        let chip = try await requireElement(in: window, "The chip never showed the time since the server's job start") {
            $0.accessibilityLabel?.hasSuffix("is compressing the context") == true
                && $0.accessibilityValue?.hasPrefix("running for 1 minute") == true
        }
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The chip is off screen")
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains("Compressing context..."), "The composer placeholder still says it")
        // A typed command leaves the composer when it is sent, not when it finishes (the job above is still running).
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, "", "The /compress draft stayed in the composer while the command ran")
    }

    /// An edit or regenerate the server holds asks with the server's count, the edit only once its sheet has closed;
    /// Cancel keeps the transcript (TAL-929).
    func testHeldEditAndRegenerateAskWithTheServersCount() async throws {
        let window = try await hostFixtureChat(["--ui-test-compression-reference"])
        func alert() -> UIAlertController? {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller as? UIAlertController
        }
        func choose(_ title: String, on label: String) async throws {
            let row = try await requireElement(in: window, label: label)
            let hit = try XCTUnwrap(try messageMenuHit(at: row, in: window), "\(label) has no message menu")
            try XCTUnwrap(hit.content.actions.first { $0.title == title }, "\(label) offers no \(title)").handler()
        }

        try await choose("Edit Message", on: "Plan the migration.")
        let presented = await presentedController(in: window)
        let sheet = try XCTUnwrap(presented, "Edit opened no sheet")
        let send = await awaitCondition { HostedAccessibility.element(in: sheet.view, label: "Send") != nil }
        XCTAssertTrue(send, "The edit sheet has no Send")
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: sheet.view, label: "Send")))
        let editAsked = await awaitCondition { alert() != nil }
        XCTAssertTrue(editAsked, "The held edit never asked")
        XCTAssertEqual(alert()?.title, "Discard Later Messages?")
        XCTAssertEqual(alert()?.message, "Editing this message will discard 5 later messages.")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        let editCancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(editCancelled, "Cancel left the confirmation up")

        try await choose("Regenerate Response", on: "Here is the plan.")
        let regenerateAsked = await awaitCondition { alert() != nil }
        XCTAssertTrue(regenerateAsked, "The held regenerate never asked")
        XCTAssertEqual(alert()?.message, "Regenerating this response will discard 5 later messages.")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        let regenerateCancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(regenerateCancelled, "Cancel left the confirmation up")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Step one done."), "Cancel changed the transcript")
    }

    /// What the transcript's long press resolves to at `element`'s centre (TAL-485): the press handler's own registry
    /// and policy, read from the hosted transcript. The touch arbitration itself is the phone check's.
    private func messageMenuTarget(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuTarget? {
        guard let hit = try messageMenuHit(at: element, in: window) else { return nil }
        return ChatMessageMenuPolicy.target(
            at: hit.localPoint, linkRegions: hit.content.linkRegions, controlRegions: hit.content.controlRegions
        )
    }

    /// The message row a long press at `element`'s centre lands on, from the press handler's own registry.
    private func messageMenuHit(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuRegistry.Hit? {
        let host = try XCTUnwrap(window.firstView(ofType: ChatMessageMenuHostView.self), "The transcript has no long-press handler")
        let stored = Dictionary(uniqueKeysWithValues: Mirror(reflecting: host).children.compactMap { child in
            child.label.map { ($0, child.value) }
        })
        let registry = try XCTUnwrap(stored["registry"] as? ChatMessageMenuRegistry)
        let scrollView = try transcriptScrollView(in: window)
        let frame = window.convert(element.accessibilityFrame, from: nil)
        let point = scrollView.convert(CGPoint(x: frame.midX, y: frame.midY), from: window)
        return registry.hit(at: point, in: scrollView)
    }

    private func transcriptScrollView(in window: UIWindow) throws -> UIScrollView {
        let host = try XCTUnwrap(window.firstView(ofType: ChatMessageMenuHostView.self))
        return try XCTUnwrap(host.superview.flatMap {
            sequence(first: $0, next: \.superview).first { $0 is UIScrollView } as? UIScrollView
        })
    }
}
