import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1052: Tent Stand shows the closed iPhone Duo's outer display in landscape, compact in both dimensions. The chat
/// stays the root with its composer at the bottom, and the sidebar opens as the full-screen drawer over it.
///
/// The geometry is synthetic, not a hardware measurement: the window takes `HostedSize.duoOuterLandscape` and a safe
/// area with the cover's status and camera column on one side only, as the phone's two landscape directions place it.
/// A hosted window sized for another display takes no vertical bar, so these tests prove the App's own layout and
/// state; the native posture and system toolbars are checked on the Duo simulator (`app/docs/phone-checks.md`).
@MainActor
final class DuoOuterLandscapeHostedTests: XCTestCase {
    /// The column on the left, as when the phone turns one way, and on the right, as when it turns the other.
    private static let safeAreas: [(name: String, insets: UIEdgeInsets)] = [
        ("column-left", UIEdgeInsets(top: 0, left: 77, bottom: 21, right: 0)),
        ("column-right", UIEdgeInsets(top: 0, left: 0, bottom: 21, right: 77)),
    ]

    /// `view` in an outer-landscape window whose whole safe area is `insets`.
    private func hostOuterLandscape(
        _ view: some View, insets: UIEdgeInsets,
        traits: (inout UITraitOverrides) -> Void = { _ in }
    ) throws -> UIWindow {
        let window = try hostWindow(view, size: HostedSize.duoOuterLandscape, traits: traits)
        applySafeArea(insets, to: window)
        XCTAssertEqual(window.traitCollection.horizontalSizeClass, .compact)
        XCTAssertEqual(window.traitCollection.verticalSizeClass, .compact)
        return window
    }

    /// The part of the window the screen's content may use: inside the safe area and below the navigation bar.
    private func usableFrame(in window: UIWindow) throws -> CGRect {
        let root = try XCTUnwrap(window.rootViewController)
        var usable = root.view.convert(root.view.safeAreaLayoutGuide.layoutFrame, to: window)
        let bars = window.views(ofType: UINavigationBar.self) { !$0.isHidden && $0.window != nil }
        if let barBottom = bars.map({ $0.convert($0.bounds, to: window).maxY }).max(), barBottom > usable.minY {
            usable = usable.divided(atDistance: barBottom - usable.minY, from: .minYEdge).remainder
        }
        return usable
    }

    /// The frame of the lowest element labelled `label`: the composer's, where the toolbar repeats an action.
    private func frame(of label: String, in window: UIWindow) async throws -> CGRect {
        _ = try await requireElement(in: window, label: label)
        let frames = HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == label }
            .map { window.convert($0.accessibilityFrame, from: nil) }
        return try XCTUnwrap(frames.max { $0.maxY < $1.maxY })
    }

    /// Fails unless `label` shows, with a nonempty frame, within `usable`. `hitSlack` lets a control's minimum hit
    /// target reach that far past the card it sits in, as the composer's controls do while a question is open.
    private func assertWithin(_ usable: CGRect, _ label: String, in window: UIWindow, _ context: String, hitSlack: CGFloat = 1,
                              file: StaticString = #filePath, line: UInt = #line) async throws {
        let frame = try await frame(of: label, in: window)
        XCTAssertFalse(frame.isEmpty, "\(context): \(label) has no size", file: file, line: line)
        XCTAssertTrue(usable.insetBy(dx: -1, dy: -hitSlack).contains(frame),
                      "\(context): \(label) at \(frame) leaves the usable area \(usable)", file: file, line: line)
    }

    /// A 44 pt hit target around a control drawn smaller reaches a few points past its card's edge.
    private static let questionHitSlack: CGFloat = 4

    func testTheChatFitsEitherSafeAreaLeftToRight() async throws {
        try await assertTheChatFitsEitherSafeArea(.leftToRight)
    }

    func testTheChatFitsEitherSafeAreaRightToLeft() async throws {
        try await assertTheChatFitsEitherSafeArea(.rightToLeft)
    }

    /// The transcript, the composer and its Send keep a nonempty frame inside the side the column leaves free, and the
    /// composer's leading control follows the layout direction.
    private func assertTheChatFitsEitherSafeArea(_ direction: UITraitEnvironmentLayoutDirection) async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        // The system direction flips the navigation chrome; the chat canvas follows the RTL chat setting (#259).
        let key = ChatTranscriptDisplaySettings.rtlChatLayoutEnabledKey
        UserDefaults.standard.set(direction == .rightToLeft, forKey: key)
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: key) }
        for (name, insets) in Self.safeAreas {
            let context = "\(direction == .rightToLeft ? "RTL" : "LTR") \(name)"
            let window = try hostOuterLandscape(fixture.chat(session), insets: insets) { $0.layoutDirection = direction }
            let row = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
            settle(0.3, window: window)
            XCTAssertNil(HostedAccessibility.splitViewController(under: window.rootViewController),
                         "\(context): a wide compact display must not take the split view")
            let usable = try usableFrame(in: window)
            let rowFrame = window.convert(row.accessibilityFrame, from: nil)
            XCTAssertGreaterThanOrEqual(rowFrame.minX, usable.minX - 1, "\(context): the transcript runs under the column")
            XCTAssertLessThanOrEqual(rowFrame.maxX, usable.maxX + 1, "\(context): the transcript runs under the column")
            let transcript = try XCTUnwrap(mountedTranscriptScrollView(in: window))
            XCTAssertGreaterThan(transcript.convert(transcript.bounds, to: window).intersection(usable).height,
                                 ComposerCardSizing.minimumTranscriptHeight, "\(context): the transcript lost its height")
            for label in ["Composer options", "Message", "Send", "Select model"] {
                try await assertWithin(usable, label, in: window, context)
            }
            let leading = try await frame(of: "Composer options", in: window).midX
            let send = try await frame(of: "Send", in: window).midX
            XCTAssertEqual(leading < send, direction == .leftToRight, "\(context): + is not on the leading side")
            attachHostedScreenshot(window, name: "outer-landscape-\(context)")
            HostedScene.dismantle(window)
        }
    }

    /// A long draft stops growing where the transcript's minimum begins, and Send stays in view.
    func testALongDraftLeavesTheTranscriptItsMinimum() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let window = try hostOuterLandscape(fixture.chat(session), insets: Self.safeAreas[0].insets)
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let draft = (1...16).map { "Tent draft line \($0)" }.joined(separator: "\n")
        try await typeIntoComposer(draft, in: window)
        let found = await composerTextView(in: window)
        let editor = try XCTUnwrap(found)
        let settled = await awaitQuiet { editor.convert(editor.bounds, to: window) }
        let editorFrame = try XCTUnwrap(settled, "The editor kept resizing")
        let usable = try usableFrame(in: window)
        XCTAssertEqual(editor.text, draft)
        XCTAssertFalse(editorFrame.isEmpty)
        XCTAssertTrue(usable.insetBy(dx: -1, dy: -1).contains(editorFrame), "The editor at \(editorFrame) leaves \(usable)")
        XCTAssertGreaterThanOrEqual(editorFrame.minY - usable.minY, ComposerCardSizing.minimumTranscriptHeight - 1,
                                    "The draft took the transcript's minimum: editor at \(editorFrame), content from \(usable.minY)")
        XCTAssertGreaterThan(editor.contentSize.height, editor.bounds.height, "The capped draft must scroll inside the editor")
        try await assertWithin(usable, "Send", in: window, "Long draft")
        attachHostedScreenshot(window, name: "outer-landscape-long-draft")
    }

    /// At the largest text size every composer control keeps a frame below the navigation bar and inside the safe area,
    /// and the transcript still scrolls.
    func testTheLargestTextKeepsEveryComposerControlInView() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let window = try hostOuterLandscape(fixture.chat(session), insets: Self.safeAreas[1].insets) {
            $0.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        }
        // The tall last reply fills the viewport, so the latest short row may not be on screen.
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("FixturePlainLead") == true }
        settle(0.3, window: window)
        let usable = try usableFrame(in: window)
        for label in ["Composer options", "Message", "Send"] {
            try await assertWithin(usable, label, in: window, "AX5")
        }
        let transcript = try XCTUnwrap(mountedTranscriptScrollView(in: window))
        XCTAssertTrue(transcript.isScrollEnabled)
        XCTAssertGreaterThan(transcript.contentSize.height, transcript.bounds.height, "Earlier rows must stay reachable by scrolling")
        attachHostedScreenshot(window, name: "outer-landscape-ax5")
    }

    /// An approval's choices each scroll into view within its card, above the composer; allowing it brings the
    /// clarification, whose choice answers it.
    func testAnApprovalAndAClarificationStayAnswerable() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-full"], for: self)
        let session = try await fixture.session()
        let window = try hostOuterLandscape(fixture.chat(session), insets: Self.safeAreas[0].insets)
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Allow once")
        await composerTextView(in: window)?.resignFirstResponder()
        // The panel takes its height once the composer around it has measured.
        _ = await awaitQuiet { self.composerFrame(in: window) }
        let usable = try usableFrame(in: window)
        // The question panel takes only what the answer field, its controls and the strip under the card leave.
        for label in ["Stop response", "Select model"] {
            try await assertWithin(usable, label, in: window, "Approval", hitSlack: Self.questionHitSlack)
        }
        let stop = try await frame(of: "Stop response", in: window)
        for choice in ["Allow once", "Allow session", "Always allow", "Deny", "Skip all this session"] {
            let shown = try await revealInItsCard(choice, in: window)
            XCTAssertTrue(usable.contains(shown), "\(choice) at \(shown) leaves \(usable)")
            XCTAssertLessThanOrEqual(shown.maxY, stop.minY, "\(choice) at \(shown) sits under the composer")
        }
        attachHostedScreenshot(window, name: "outer-landscape-approval")
        _ = try await revealInItsCard("Allow once", in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Allow once"))
        _ = try await requireElement(in: window, label: "Clarification Required")
        _ = await awaitQuiet { HostedAccessibility.element(in: window, label: "Submit clarification")?.accessibilityFrame }
        let choice = try await revealInItsCard("Use the deterministic path", in: window)
        XCTAssertTrue(usable.contains(choice), "The clarification's choice at \(choice) leaves \(usable)")
        try await assertWithin(usable, "Submit clarification", in: window, "Clarification", hitSlack: Self.questionHitSlack)
        attachHostedScreenshot(window, name: "outer-landscape-clarification")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Use the deterministic path"))
        let answered = await awaitNoElement(in: window) { $0.accessibilityLabel == "Clarification Required" }
        XCTAssertTrue(answered, "Choosing the clarification's answer never answered it")
    }

    /// Scrolls the question card holding `label` until the element lies within the card's visible height, and returns
    /// its frame in the window.
    private func revealInItsCard(_ label: String, in window: UIWindow) async throws -> CGRect {
        let transcript = mountedTranscriptScrollView(in: window)
        var shown = CGRect.null
        let revealed = await awaitCondition {
            guard let element = HostedAccessibility.element(in: window, label: label) else { return false }
            shown = window.convert(element.accessibilityFrame, from: nil)
            let center = CGPoint(x: shown.midX, y: shown.midY)
            // Each poll finds the card afresh: on a slow host its content is still sizing when the element first appears.
            guard let card = window.firstView(ofType: UIScrollView.self, where: { scroll in
                scroll !== transcript && CGRect(origin: .zero, size: scroll.contentSize).contains(scroll.convert(center, from: window))
            }) else { return false }
            let viewport = card.convert(card.bounds, to: window)
            if shown.minY < viewport.minY || shown.maxY > viewport.maxY {
                let bottom = max(0, card.contentSize.height + card.adjustedContentInset.bottom - card.bounds.height)
                card.setContentOffset(CGPoint(x: 0, y: min(bottom, max(0, card.contentOffset.y + shown.midY - viewport.midY))),
                                      animated: false)
                return false
            }
            return !shown.isEmpty
        }
        XCTAssertTrue(revealed, "\(label) never scrolled into view in its card; last at \(shown)")
        return shown
    }

    /// The model sheet opens and changes the model; the attachment menu offers its sources, and a staged file shows
    /// with its Remove inside the usable area.
    func testModelAndAttachmentActionsStayReachable() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        let model = ChatViewModel(session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
                                  liveActivityManager: SpyChatLiveActivityManager())
        defer { model.cleanupPollingTasks() }
        let window = try hostOuterLandscape(fixture.chat(session, viewModel: model), insets: Self.safeAreas[1].insets)
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let usable = try usableFrame(in: window)

        let sources = try await hostedMenuActions("Composer options", readyAction: "Attach File", in: window)
        XCTAssertTrue(["Attach File", "Photos"].allSatisfy { title in
            sources.contains { $0.title == title && !$0.attributes.contains(.disabled) }
        }, "Attachment sources: \(sources.map(\.title))")
        let staged = await model.stageAttachment(data: Data("Tent notes".utf8), filename: "tent-notes.txt")
        XCTAssertNotNil(staged)
        try await assertWithin(usable, "Open attachment tent-notes.txt", in: window, "Staged file")
        try await assertWithin(usable, "Remove attachment tent-notes.txt", in: window, "Staged file")
        attachHostedScreenshot(window, name: "outer-landscape-staged-file")

        try await assertWithin(usable, "Select model", in: window, "Model")
        let modelButton = try await requireElement(in: window, label: "Select model")
        XCTAssertTrue(HostedAccessibility.activate(modelButton))
        _ = try await requireElement(in: window, label: "Options")
        let search = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.placeholder == "Search models" })
        search.text = "Alternative"
        search.sendActions(for: .editingChanged)
        let row = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-alternative"
        }
        XCTAssertTrue(HostedAccessibility.activate(row))
        let selected = await awaitCondition {
            HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-alternative")?
                .accessibilityTraits.contains(.selected) == true
        }
        XCTAssertTrue(selected, "Choosing a model in the outer-landscape sheet did not select it")
        attachHostedScreenshot(window, name: "outer-landscape-model-sheet")
    }

    /// The sidebar opens as a drawer over the whole usable width; a section opened from it replaces the chat, and
    /// picking the chat again from the drawer brings back its draft.
    func testADrawerSectionReplacesTheChatAndTheChatReturnsWithItsDraft() async throws {
        // A hosted window reads no hinge; Tent Stand's partly open one is what makes the drawer fill the display.
        let fixture = try FixtureApp([UITestFixtureEnvironment.tentHingeArgument], for: self)
        let window = try hostOuterLandscape(fixture.sessionList(), insets: Self.safeAreas[0].insets)
        func isFixtureChatRow(_ element: NSObject) -> Bool {
            element.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        }
        try await openSidebar(in: window)
        XCTAssertNil(HostedAccessibility.splitViewController(under: window.rootViewController), "The outer display must use the drawer")
        let drawer = try XCTUnwrap(window.rootViewController?.firstDescendant(ofType: AppSidebarController.self))
        let available = drawer.view.bounds.width - drawer.view.safeAreaInsets.left - drawer.view.safeAreaInsets.right
        let fills = await awaitCondition(timeout: 2) { drawer.revealWidth == available }
        XCTAssertTrue(fills, "The drawer is \(drawer.revealWidth) of the outer display's \(available) points")
        attachHostedScreenshot(window, name: "outer-landscape-drawer")

        HostedAccessibility.activate(try await requireElement(in: window, where: isFixtureChatRow))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        try await typeIntoComposer("Tent drawer draft", in: window)
        window.endEditing(true)

        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Insights"))
        let replaced = await awaitCondition { self.composerDraftText(in: window) == nil }
        XCTAssertTrue(replaced, "Insights did not replace the chat")
        _ = try await requireElement(in: window, label: "Open navigation")
        XCTAssertTrue(window.navigationStacks.allSatisfy { $0.viewControllers.count == 1 }, "Insights must be the root, not pushed over the chat")
        attachHostedScreenshot(window, name: "outer-landscape-section")

        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, where: isFixtureChatRow))
        let restored = await awaitCondition { self.composerDraftText(in: window) == "Tent drawer draft" }
        XCTAssertTrue(restored, "The chat returned with \(composerDraftText(in: window) ?? "no composer"), not its draft")
    }
}
