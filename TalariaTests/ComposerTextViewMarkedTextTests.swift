import SwiftUI
import UIKit
import XCTest

@testable import Talaria

@MainActor
final class ComposerTextViewMarkedTextTests: XCTestCase {
    private final class Draft {
        var writeCount = 0
        var isFocused = false
        var text = "" {
            didSet { writeCount += 1 }
        }
    }

    // MARK: - Marked text protection

    func testStaleUpdateDuringCompositionKeepsMarkedTextAndSelection() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        coordinator.applyBoundText("hello ", to: textView)

        beginComposition("あ", in: textView, coordinator: coordinator)
        let composedText = textView.text ?? ""
        let composedSelection = textView.selectedRange

        coordinator.applyBoundText("hello ", to: textView)

        XCTAssertEqual(textView.text, composedText)
        XCTAssertNotNil(textView.markedTextRange)
        XCTAssertEqual(textView.selectedRange, composedSelection)
        XCTAssertEqual(draft.text, composedText)
    }

    func testCommittedCompositionIsNotReplacedByAnEarlierBindingValue() {
        let (_, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)

        beginComposition("あ", in: textView, coordinator: coordinator)
        let composedText = textView.text ?? ""
        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        // "hello " was published before the composition and SwiftUI has not echoed
        // the committed value yet, so this update is catch-up, not an external edit.
        coordinator.applyBoundText("hello ", to: textView)

        XCTAssertEqual(textView.text, composedText)
    }

    // MARK: - Deliberate external replacement

    func testDeliberateReplacementDuringCompositionIsAppliedOnceAfterComposition() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        coordinator.applyBoundText("hello ", to: textView)

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
        coordinator.applyBoundText("hello ", to: textView)

        beginComposition("あ", in: textView, coordinator: coordinator)
        setDraftExternally("/help ", draft: draft, coordinator: coordinator, textView: textView)

        // The composition continues; its provisional text must not overwrite the
        // replacement the binding is already holding.
        textView.setMarkedText("あい", selectedRange: NSRange(location: 2, length: 0))
        coordinator.textViewDidChange(textView)
        XCTAssertEqual(draft.text, "/help ")

        coordinator.applyBoundText("/help ", to: textView)
        textView.unmarkText()
        coordinator.textViewDidChange(textView)

        XCTAssertEqual(textView.text, "/help ")
        XCTAssertEqual(draft.text, "/help ")
    }

    func testFlushingADeferredReplacementDoesNotWriteBackToTheBinding() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        coordinator.applyBoundText("hello ", to: textView)

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

    func testExternalReplacementOutsideCompositionAppliesImmediately() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello", into: textView, coordinator: coordinator)

        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)

        XCTAssertEqual(textView.text, "")
    }

    func testEndingEditingFlushesADeferredReplacement() {
        let (draft, coordinator, textView) = makeComposer()
        type("hello ", into: textView, coordinator: coordinator)
        coordinator.applyBoundText("hello ", to: textView)

        beginComposition("あ", in: textView, coordinator: coordinator)
        setDraftExternally("", draft: draft, coordinator: coordinator, textView: textView)

        textView.unmarkText()
        coordinator.textViewDidEndEditing(textView)

        XCTAssertEqual(textView.text, "")
    }

    // MARK: - Replacement classification

    func testCatchUpValuesOnlyDifferInsideTheMarkedRange() {
        XCTAssertFalse(
            ComposerMarkedText.isDeliberateReplacement(
                "hello ",
                editorText: "hello あ",
                markedRange: NSRange(location: 6, length: 1)
            )
        )
        XCTAssertFalse(
            ComposerMarkedText.isDeliberateReplacement(
                "hello k end",
                editorText: "hello か end",
                markedRange: NSRange(location: 6, length: 1)
            )
        )
        XCTAssertTrue(
            ComposerMarkedText.isDeliberateReplacement(
                "/help ",
                editorText: "hello あ",
                markedRange: NSRange(location: 6, length: 1)
            )
        )
        XCTAssertTrue(
            ComposerMarkedText.isDeliberateReplacement(
                "",
                editorText: "hello あ",
                markedRange: NSRange(location: 6, length: 1)
            )
        )
        XCTAssertTrue(
            ComposerMarkedText.isDeliberateReplacement(
                "",
                editorText: "あ",
                markedRange: NSRange(location: 0, length: 1)
            ),
            "a fully marked draft has no surrounding text to compare"
        )
        XCTAssertTrue(
            ComposerMarkedText.isDeliberateReplacement(
                "anything",
                editorText: "hello",
                markedRange: NSRange(location: NSNotFound, length: 0)
            )
        )
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

    /// Mirrors keyboard input: the text view changes, then the delegate publishes.
    private func type(
        _ input: String,
        into textView: UITextView,
        coordinator: ComposerTextView.Coordinator
    ) {
        textView.insertText(input)
        coordinator.textViewDidChange(textView)
    }

    /// Mirrors an external draft writer: it sets the binding, and SwiftUI then
    /// delivers the new value to the representable.
    private func setDraftExternally(
        _ value: String,
        draft: Draft,
        coordinator: ComposerTextView.Coordinator,
        textView: UITextView
    ) {
        draft.text = value
        coordinator.applyBoundText(value, to: textView)
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
