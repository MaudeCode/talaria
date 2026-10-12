import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The fixture chat's media, long bodies, background work and pending steers, hosted in process (TAL-856).
@MainActor
final class ChatHostedTests: XCTestCase {
    /// Server-rewritten media renders inside the Markdown around it, audio follows as a tile, and its Export opens the
    /// file exporter (TAL-186). Saving through the exporter is the phone check's.
    func testServerMediaRendersInsideTheMarkdownAroundIt() async throws {
        let window = try await hostFixtureChat(["--ui-test-transcript-media"])
        _ = try await requireElement(in: window, label: "Linked chart", "The linked image did not render as a thumbnail")
        // Thumbnails show a spinner until their bytes load, then the image in its 132-point box or, on failure, a
        // shorter unavailable chip under the same alt-text name.
        let loaded = await awaitCondition { !window.containsView(ofType: UIActivityIndicatorView.self) }
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

    /// The background-work card shows the server's records, a delegation row its subagents' progress, the full
    /// result on request, and a shared Dismiss that removes only finished work (TAL-372).
    func testTheCardShowsTheServersRecordsAndADelegationRowItsProgress() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        _ = try await requireElement(in: window, label: "Background work", "The background card is missing")
        let containing: (String) -> (NSObject) -> Bool = { text in { $0.accessibilityLabel?.contains(text) == true } }
        let running = await awaitElement(in: window, where: containing("Fix CI"))
        XCTAssertNotNil(running, "The running delegation is missing")
        XCTAssertTrue(HostedAccessibility.elements(in: window).contains(where: containing("Summarize the repo")), "The finished /background task is missing")

        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Worked", in: window).first, "The delegation row has no Worked disclosure"))
        let progress = await awaitElement(in: window, where: containing("2 of 3 done · 1 failed"))
        XCTAssertNotNil(progress, "The delegation row does not show its subagents' progress")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Show result"))
        _ = try await requireElement(in: window, label: "The repo has three packages.", "The full result did not load")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let closed = await awaitNoElement(in: window) { $0.accessibilityLabel == "The repo has three packages." }
        XCTAssertTrue(closed, "The result sheet did not close")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Dismiss"))
        let dismissed = await awaitNoElement(in: window, where: containing("Summarize the repo"))
        XCTAssertTrue(dismissed, "Dismiss left the finished task in the card")
        XCTAssertTrue(HostedAccessibility.elements(in: window).contains(where: containing("Fix CI")), "Dismiss removed running work")
    }

    /// Steers pending from another device offer only the actions the server allows; Send now explains itself when
    /// nothing can take it, and Edit appends the steer after the draft (TAL-300).
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

        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Send now", in: window).first))
        let notice = await awaitElement(in: window) { $0.accessibilityLabel?.contains("it stays pending") == true }
        XCTAssertNotNil(notice, "Send now gave no notice when nothing could take it")

        // Edit appends the steer after the draft, a blank line between.
        try await typeIntoComposer("Draft", in: window)
        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Edit steering message", in: window).first))
        let edited = await awaitNoElement(in: window) { $0.accessibilityLabel == "Check the backup logs too" }
        XCTAssertTrue(edited, "The edited steer is still pending")
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, "Draft\n\nCheck the backup logs too")
    }

    /// What the transcript's long press resolves to at `element`'s centre (TAL-485): the press handler's own registry
    /// and policy, read from the hosted transcript. The touch arbitration itself is the phone check's.
    private func messageMenuTarget(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuTarget? {
        let host = try XCTUnwrap(window.firstView(ofType: ChatMessageMenuHostView.self), "The transcript has no long-press handler")
        let stored = Dictionary(uniqueKeysWithValues: Mirror(reflecting: host).children.compactMap { child in
            child.label.map { ($0, child.value) }
        })
        let registry = try XCTUnwrap(stored["registry"] as? ChatMessageMenuRegistry)
        let scrollView = try XCTUnwrap(host.superview.flatMap { sequence(first: $0, next: \.superview).first { $0 is UIScrollView } })
        let frame = window.convert(element.accessibilityFrame, from: nil)
        let point = scrollView.convert(CGPoint(x: frame.midX, y: frame.midY), from: window)
        guard let hit = registry.hit(at: point, in: scrollView) else { return nil }
        return ChatMessageMenuPolicy.target(
            at: hit.localPoint, linkRegions: hit.content.linkRegions, controlRegions: hit.content.controlRegions
        )
    }

    /// The controller the window's screen presented on top, once it is on screen.
    private func presentedController(in window: UIWindow, timeout: TimeInterval = 5) async -> UIViewController? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            if controller !== window.rootViewController { return controller }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return nil
    }
}
