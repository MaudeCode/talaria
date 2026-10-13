import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The fixture chat's scripted runs, hosted in process (TAL-856): steering and stopping, clarifications in the
/// composer, and a full run that settles without duplicates. Where the keyboard frames the composer is the phone
/// check's (`app/docs/phone-checks.md`); here the composer's focus says whether it asked for the keyboard.
@MainActor
final class StreamHostedTests: XCTestCase {
    func testProviderWarningsRemainVisibleWhileTheTurnContinues() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-controls", "--ui-test-chat-warnings"])
        _ = try await startControlsRun(in: window)
        let warning = "⚠️ custom stream drop — attempt 1/3 dropped, reconnecting"
        let notice = await awaitElement(in: window, where: label(warning))
        attachWarningScreenshot(window, name: "provider-warning-phone")
        XCTAssertNotNil(notice, "The server's warning was discarded")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Stop response"))

        try await sendFromComposer("Keep the fixture concise", in: window)
        let diagnosis = "❌ Could not open a stream to provider.invalid after 3 attempts; the endpoint looks unreachable — try again in a moment."
        let finalNotice = await awaitElement(in: window, where: label(diagnosis))
        attachWarningScreenshot(window, name: "provider-diagnosis-phone")
        XCTAssertNotNil(finalNotice, "The closing diagnosis was discarded")
        XCTAssertNil(HostedAccessibility.element(in: window, label: warning))
        let stop = try await requireElement(in: window, label: "Stop response")
        HostedAccessibility.activate(stop)
    }

    private func attachWarningScreenshot(_ window: UIWindow, name: String) {
        let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func label(_ text: String) -> (NSObject) -> Bool { { $0.accessibilityLabel == text } }
    private func labelContaining(_ text: String) -> (NSObject) -> Bool { { $0.accessibilityLabel?.contains(text) == true } }
    private func labelHasPrefix(_ text: String) -> (NSObject) -> Bool { { $0.accessibilityLabel?.hasPrefix(text) == true } }
    private func isEnabled(_ element: NSObject) -> Bool { !element.accessibilityTraits.contains(.notEnabled) }

    private func composerText(in window: UIWindow) async -> String? {
        await composerTextView(in: window)?.text
    }

    private func startControlsRun(in window: UIWindow) async throws -> NSObject {
        try await sendFromComposer("Run the deterministic fixture", in: window)
        return try await requireElement(in: window, label: "Waiting for control input.", "The controls run never streamed its opening")
    }

    /// A run waiting on the test heartbeats like the server's stream, so the stall watchdog never shows Checking stream
    /// (after 12 s) or reconnects and replays the run (at 18 s) (TAL-666).
    func testWaitingRunKeepsItsStreamAlive() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-controls"])
        _ = try await startControlsRun(in: window)
        let checking = await awaitElement(in: window, timeout: 22, where: label("Hermes is checking the response stream"))
        XCTAssertNil(checking, "A waiting run's stream looked stalled")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Waiting for control input."), "The run was replayed by a reconnect")
    }

    /// A message sent during a run steers it and shows as a steering hint; Stop ends the turn, which settles into the
    /// server's scene with its outcome and the steer it took (TAL-300).
    func testChatStreamSupportsSteeringAndCancellation() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-controls"])
        _ = try await startControlsRun(in: window)
        try await sendFromComposer("Keep the fixture concise", in: window)

        _ = try await requireElement(in: window, label: "Keep the fixture concise")
        let hint = await awaitElement(in: window, where: labelContaining("Steering hint"))
        XCTAssertNotNil(hint)
        let stop = try await requireElement(in: window, label: "Stop response")
        HostedAccessibility.activate(stop)

        let stopped = await awaitNoElement(in: window, timeout: 5, where: label("Stop response"))
        XCTAssertTrue(stopped)
        _ = try await requireElement(in: window, label: "Stopped")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Keep the fixture concise"))
        let composer = await awaitElement(in: window, where: label("Message"))
        let input = await composerTextView(in: window, timeout: 1)
        XCTAssertTrue(composer != nil || input != nil, "The composer went away")
    }

    /// A batch of questions shows its choices inside the composer without raising the keyboard, resizes, steps between
    /// questions keeping each answer, and submits typed and selected answers together (TAL-367).
    func testBatchClarificationShowsChoicesAndDeliversTypedAndMultiSelectAnswers() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-batch-clarification"])
        _ = try await requireElement(in: window, label: "What sounds best for a quiet evening?")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "A movie"))
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "A book"))
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Question 1 of 2"))
        let composer = await composerTextView(in: window)
        XCTAssertFalse(composer?.isFirstResponder ?? false, "The batch raised the keyboard")

        let resize = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Resize question area"))
        let originalTop = resize.accessibilityFrame.minY
        resize.accessibilityIncrement()
        resize.accessibilityIncrement()
        let grown = await awaitElement(in: window) {
            $0.accessibilityLabel == "Resize question area" && $0.accessibilityFrame.minY < originalTop - 30
        }
        XCTAssertNotNil(grown, "The question area did not grow")

        try await typeIntoComposer("A movie", in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Next"))
        _ = try await requireElement(in: window, label: "Which drinks?")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Question 2 of 2"))
        let secondAnswer = await composerText(in: window)
        XCTAssertEqual(secondAnswer, "")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Tea"))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Water"))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Previous question"))
        let firstAnswer = await composerText(in: window)
        XCTAssertEqual(firstAnswer, "A movie")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Next question"))
        let submit = await awaitElement(in: window) { $0.accessibilityLabel == "Submit clarification" && !$0.accessibilityTraits.contains(.notEnabled) }
        HostedAccessibility.activate(try XCTUnwrap(submit, "Submit never enabled"))

        _ = try await requireElement(in: window, label: "Agent received: A movie | Tea, Water")
        let restored = await composerText(in: window)
        XCTAssertEqual(restored, "Ordinary fixture draft")
    }

    /// Answering a clarification in the composer leaves the ordinary draft restored, and it stays after a reopen
    /// (TAL-187).
    func testClarificationRestoresOrdinaryDraftAfterAnswerAndNavigation() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-clarification"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: window, label: "Clarification Required")
        let empty = await composerText(in: window)
        XCTAssertEqual(empty, "")
        try await typeIntoComposer("Temporary fixture answer", in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Submit clarification"))
        let answered = await awaitNoElement(in: window, timeout: 5, where: label("Clarification Required"))
        XCTAssertTrue(answered)
        _ = try await requireElement(in: window, label: "Agent received: Temporary fixture answer")
        let restored = await composerText(in: window)
        XCTAssertEqual(restored, "Ordinary fixture draft")
        window.isHidden = true

        // The reopened chat's composer, expanded or collapsed, holds the ordinary draft again.
        let reopened = try hostWindow(fixture.chat(session))
        let draftShown = await awaitElement(in: reopened) {
            $0.accessibilityLabel == "Ordinary fixture draft" || $0.accessibilityValue == "Ordinary fixture draft"
                || ($0 as? UITextView)?.text == "Ordinary fixture draft"
        }
        let input = await composerTextView(in: reopened, timeout: 1)
        XCTAssertTrue(draftShown != nil || input?.text == "Ordinary fixture draft", "The reopened chat lost its ordinary draft")
    }

    /// A full run streams its rows in order, takes an approval and a slash-text clarification answer in the composer,
    /// and after a reopen settles into the server's transcript once each, with the clipped tool result and the file
    /// edit's diff on request (TAL-331, TAL-448).
    func testChatStreamPreservesChronologyAndSettlesWithoutDuplication() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-full"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(fixture.chat(session))
        try await sendFromComposer("Run the deterministic fixture", in: window)

        _ = try await requireElement(in: window, label: "Run the deterministic fixture")
        _ = try await requireElement(in: window, label: "Approval required")
        let opening = try await requireElement(in: window, label: "Fixture opening.")
        let liveThinking = try await requireElement(in: window, where: labelContaining("Thinking, Inspecting fixture"))
        let liveProgress = try await requireElement(in: window, label: "Fixture progress.")
        let liveTool = try await requireElement(in: window, where: labelContaining("Calling a tool, Running"))
        XCTAssertLessThan(opening.accessibilityFrame.minY, liveThinking.accessibilityFrame.minY)
        XCTAssertLessThan(liveThinking.accessibilityFrame.minY, liveProgress.accessibilityFrame.minY)
        XCTAssertLessThan(liveProgress.accessibilityFrame.minY, liveTool.accessibilityFrame.minY)

        HostedAccessibility.activate(try await requireElement(in: window, label: "Allow once"))
        _ = try await requireElement(in: window, label: "Clarification Required")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Which deterministic path should continue?"))
        _ = try await requireElement(in: window, label: "Fixture finished.")

        // The clarification uses only the composer, and slash text there is an answer, not a command.
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Use the deterministic path"))
        XCTAssertFalse(window.containsView(ofType: UITextField.self), "The clarification brought a separate text field")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Stop response"))
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Composer options"))
        let send = try await requireElement(in: window, label: "Submit clarification")
        XCTAssertFalse(isEnabled(send))
        try await typeIntoComposer("/interrupt is my answer", in: window)
        let enabled = await awaitElement(in: window) { $0.accessibilityLabel == "Submit clarification" && !$0.accessibilityTraits.contains(.notEnabled) }
        HostedAccessibility.activate(try XCTUnwrap(enabled, "Submit never enabled"))
        _ = try await requireElement(in: window, "The run's title never arrived", where: labelHasPrefix("Deterministic Stream Complete"))
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Clarification Required"))
        XCTAssertNil(HostedAccessibility.element(in: window, label: "/interrupt is my answer"))
        let settled = await awaitNoElement(in: window, timeout: 5, where: label("Stop response"))
        XCTAssertTrue(settled)
        window.isHidden = true

        let reopened = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: reopened, "The reopened chat lost its title", where: labelHasPrefix("Deterministic Stream Complete"))
        let worked = try await requireElement(in: reopened, where: label("Worked"))
        HostedAccessibility.activate(worked)
        let reloadedOpening = try await requireElement(in: reopened, label: "Fixture opening.")
        let reloadedThinking = try await requireElement(in: reopened, where: labelContaining("Thinking, Inspecting fixture"))
        let reloadedProgress = try await requireElement(in: reopened, label: "Fixture progress.")
        let reloadedTool = try await requireElement(in: reopened, where: labelContaining("Called a tool, Completed"))
        let reloadedFinished = try await requireElement(in: reopened, label: "Fixture finished.")
        XCTAssertLessThan(reloadedOpening.accessibilityFrame.minY, reloadedThinking.accessibilityFrame.minY)
        XCTAssertLessThan(reloadedThinking.accessibilityFrame.minY, reloadedProgress.accessibilityFrame.minY)
        XCTAssertLessThan(reloadedProgress.accessibilityFrame.minY, reloadedTool.accessibilityFrame.minY)
        XCTAssertLessThan(reloadedTool.accessibilityFrame.minY, reloadedFinished.accessibilityFrame.minY)
        for once in ["Run the deterministic fixture", "Fixture opening.", "Fixture progress.", "Fixture finished."] {
            XCTAssertEqual(HostedAccessibility.elements(in: reopened).filter(label(once)).count, 1, "\(once) is not shown once")
        }

        // TAL-331: the settled tool row the server clipped opens its whole result on request.
        HostedAccessibility.activate(reloadedTool)
        let showFullOutput = try await requireElement(in: reopened, label: "Show full output")
        HostedAccessibility.activate(showFullOutput)
        _ = try await requireElement(in: reopened, label: "fixture result, in full")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Show full output"))

        // TAL-448: a file edit shows the server's counts and expands to its diff, then collapses again.
        let editRow = try await requireElement(in: reopened, where: labelContaining("Edited src/app.ts, Completed, 2 added, 1 removed"))
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "+run(2)"))
        HostedAccessibility.activate(editRow)
        _ = try await requireElement(in: reopened, label: "+run(2)")
        XCTAssertNotNil(HostedAccessibility.element(in: reopened, label: "-run(1)"))
        XCTAssertNotNil(HostedAccessibility.element(in: reopened, label: "Lines 1-4"), "The server's hunk label heads the diff")
        XCTAssertNotNil(HostedAccessibility.element(in: reopened, label: "Diff truncated"))
        let collapsingRow = try await requireElement(in: reopened, where: labelContaining("Edited src/app.ts, Completed"))
        HostedAccessibility.activate(collapsingRow)
        let collapsed = await awaitNoElement(in: reopened, timeout: 5, where: label("+run(2)"))
        XCTAssertTrue(collapsed)
    }
}
