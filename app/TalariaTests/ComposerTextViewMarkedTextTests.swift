import SwiftUI
import UIKit
import XCTest

@testable import Talaria

@MainActor
final class ComposerTextViewMarkedTextTests: XCTestCase {
    /// Mirrors `ChatView`'s draft state: every write advances a revision the composer
    /// uses to order the updates it receives.
    private final class Draft {
        var revision = 0
        var writeCount = 0
        var isFocused = false
        var text = "" {
            didSet {
                revision += 1
                writeCount += 1
            }
        }
    }

    // MARK: - Marked text protection

    func testSupersededUpdateDuringCompositionKeepsMarkedTextAndSelection() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        let supersededRevision = draft.revision
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        let composedText = textView.text ?? ""
        let composedSelection = textView.selectedRange

        coordinator.applyBoundText("hello ", revision: supersededRevision, to: textView)

        XCTAssertEqual(textView.text, composedText)
        XCTAssertNotNil(textView.markedTextRange)
        XCTAssertEqual(textView.selectedRange, composedSelection)
    }

    func testCommittedCompositionIsNotReplacedByAnEarlierBindingValue() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        let supersededRevision = draft.revision
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        let composedText = textView.text ?? ""
        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        coordinator.applyBoundText("hello ", revision: supersededRevision, to: textView)

        XCTAssertEqual(textView.text, composedText)
    }

    func testCompositionReplacingTheWholeDraftIgnoresTheReplacedValue() {
        let (draft, coordinator, textView) = makeComposer()
        // A draft this composer never published, e.g. one restored on appear.
        setDraftExternally("hello", draft: draft, coordinator: coordinator, textView: textView)
        let supersededRevision = draft.revision

        // The user selects everything and composes over it.
        textView.selectedRange = NSRange(location: 0, length: 5)
        beginComposition("あ", in: textView, coordinator: coordinator)

        coordinator.applyBoundText("hello", revision: supersededRevision, to: textView)
        XCTAssertEqual(textView.text, "あ")
        XCTAssertNotNil(textView.markedTextRange)

        textView.unmarkText()
        coordinator.textViewDidChange(textView)
        XCTAssertEqual(textView.text, "あ", "the replaced draft must not come back")
    }

    // MARK: - External replacement

    func testDeliberateReplacementDuringCompositionIsAppliedOnceAfterComposition() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        let composedText = textView.text ?? ""

        setDraftExternally("/help ", draft: draft, coordinator: coordinator, textView: textView)
        XCTAssertEqual(textView.text, composedText, "the composition must survive until it ends")
        XCTAssertNotNil(textView.markedTextRange)

        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        XCTAssertEqual(textView.text, "/help ")
        XCTAssertEqual(draft.text, "/help ")

        // Applied exactly once: further editing is not overwritten by the same value.
        type("me", into: textView, coordinator: coordinator)
        XCTAssertEqual(textView.text, "/help me")
        XCTAssertEqual(draft.text, "/help me")
    }

    func testDeferredReplacementSurvivesFurtherCompositionChanges() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        setDraftExternally("/help ", draft: draft, coordinator: coordinator, textView: textView)

        // The composition continues; its provisional text must not overwrite the
        // replacement the binding is already holding.
        textView.setMarkedText("あい", selectedRange: NSRange(location: 2, length: 0))
        coordinator.textViewDidChange(textView)
        XCTAssertEqual(draft.text, "/help ")

        deliverDraft(draft, to: textView, coordinator: coordinator)
        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        XCTAssertEqual(textView.text, "/help ")
        XCTAssertEqual(draft.text, "/help ")
    }

    func testSendClearIsDeferredWhenTheWholeDraftIsAComposition() {
        let (draft, coordinator, textView) = makeComposer()
        beginComposition("あ", in: textView, coordinator: coordinator)

        // The send clears the draft while the composition still owns every character.
        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)
        XCTAssertEqual(textView.text, "あ", "the composition must survive until it ends")

        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        XCTAssertEqual(textView.text, "")
        XCTAssertEqual(draft.text, "")
    }

    func testFlushingADeferredReplacementDoesNotWriteBackToTheBinding() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        // A send clears the draft directly, without the composer's edit bookkeeping.
        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)
        let writesBeforeFlush = draft.writeCount

        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        XCTAssertEqual(textView.text, "")
        XCTAssertEqual(
            draft.writeCount,
            writesBeforeFlush,
            "flushing a value the binding already holds must not register an edit"
        )
    }

    func testARestoreAfterADeferredClearIsApplied() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello", into: textView, coordinator: coordinator)
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)

        textView.unmarkText()
        coordinator.textViewDidChange(textView)
        XCTAssertEqual(textView.text, "")

        // The send failed, so the submitted draft comes back.
        setDraftExternally("hello", draft: draft, coordinator: coordinator, textView: textView)

        XCTAssertEqual(textView.text, "hello")
    }

    func testAnExternalWriteRestoringAPreviouslyTypedValueIsApplied() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello", into: textView, coordinator: coordinator)

        // A send clears the draft, then fails and restores exactly what was typed.
        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)
        setDraftExternally("hello", draft: draft, coordinator: coordinator, textView: textView)

        XCTAssertEqual(textView.text, "hello")
    }

    func testExternalReplacementOutsideCompositionAppliesImmediately() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello", into: textView, coordinator: coordinator)

        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)

        XCTAssertEqual(textView.text, "")
    }

    func testEndingEditingFlushesADeferredReplacement() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        deliverDraft(draft, to: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)

        textView.unmarkText()
        coordinator.textViewDidEndEditing(textView)

        XCTAssertEqual(textView.text, "")
    }

    func testQueuedBlurCannotDismissAFieldTheUserJustFocused() async {
        let (draft, coordinator, _) = makeComposer()
        let view = FocusTextView()
        view.delegate = coordinator
        let dismissed = expectation(description: "A stale blur must not dismiss the keyboard")
        dismissed.isInverted = true
        view.onResign = { dismissed.fulfill() }
        coordinator.syncFocus(for: view, shouldFocus: false, isDisabled: false)
        draft.isFocused = true
        await fulfillment(of: [dismissed], timeout: 0.1)
        XCTAssertTrue(draft.isFocused)
    }

    func testQueuedBlurStillAppliesWhenFocusRemainsFalse() async {
        let (_, coordinator, _) = makeComposer()
        let view = FocusTextView()
        view.delegate = coordinator
        let dismissed = expectation(description: "Current blur is applied")
        view.onResign = { dismissed.fulfill() }
        coordinator.syncFocus(for: view, shouldFocus: false, isDisabled: false)
        await fulfillment(of: [dismissed], timeout: 1)
    }

    private final class FocusTextView: UITextView {
        var onResign: () -> Void = {}
        override var isFirstResponder: Bool { true }
        override func resignFirstResponder() -> Bool {
            onResign()
            return true
        }
    }

    // MARK: - Helpers

    private func makeComposer() -> (Draft, ComposerTextView.Coordinator, ComposerTextView.PastingTextView) {
        let draft = Draft()
        let coordinator = ComposerTextView.Coordinator(
            text: Binding(get: { draft.text }, set: { draft.text = $0 }),
            isFocused: Binding(get: { draft.isFocused }, set: { draft.isFocused = $0 }),
            onHeightChange: { _ in }
        )
        let textView = ComposerTextView.PastingTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        textView.delegate = coordinator
        return (draft, coordinator, textView)
    }

    /// Mirrors SwiftUI handing the current draft and its revision to the representable.
    private func deliverDraft(
        _ draft: Draft,
        to textView: UITextView,
        coordinator: ComposerTextView.Coordinator
    ) {
        coordinator.applyBoundText(draft.text, revision: draft.revision, to: textView)
    }

    /// Mirrors an external draft writer: it sets the state, and SwiftUI then delivers
    /// the new value and its revision to the representable.
    private func setDraftExternally(
        _ value: String,
        draft: Draft,
        coordinator: ComposerTextView.Coordinator,
        textView: UITextView
    ) {
        draft.text = value
        deliverDraft(draft, to: textView, coordinator: coordinator)
    }

    /// Mirrors keyboard input: the text view changes, then the delegate publishes.
    private func type(
        _ input: String,
        into textView: UITextView,
        coordinator: ComposerTextView.Coordinator
    ) {
        textView.insertText(input)
        coordinator.textViewDidChange(textView)
    }

    /// Mirrors an input method placing marked text, which also publishes the
    /// provisional value into the binding the way a real keyboard does.
    private func beginComposition(
        _ marked: String,
        in textView: UITextView,
        coordinator: ComposerTextView.Coordinator
    ) {
        textView.setMarkedText(marked, selectedRange: NSRange(location: marked.utf16.count, length: 0))
        coordinator.textViewDidChange(textView)
        XCTAssertNotNil(textView.markedTextRange, "the fixture must establish an active composition")
    }
}
