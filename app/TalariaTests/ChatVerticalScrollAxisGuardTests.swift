import UIKit
import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

@MainActor
final class ChatVerticalScrollAxisGuardTests: XCTestCase {
    func testGuardConfiguresEnclosingScrollViewForVerticalAxis() {
        let scrollView = makeOversizedScrollView()
        let guardView = attachGuardView(to: scrollView)

        guardView.attachToNearestScrollViewIfNeeded()

        XCTAssertFalse(scrollView.alwaysBounceHorizontal)
        XCTAssertFalse(scrollView.showsHorizontalScrollIndicator)
        XCTAssertTrue(scrollView.isDirectionalLockEnabled)
    }

    func testGuardClampsHorizontalOffsetToAdjustedLeftInset() {
        let scrollView = makeOversizedScrollView(leftInset: 12)
        let guardView = attachGuardView(to: scrollView)
        scrollView.contentOffset = CGPoint(x: 140, y: 30)

        guardView.attachToNearestScrollViewIfNeeded()

        XCTAssertEqual(scrollView.contentOffset.x, -scrollView.adjustedContentInset.left, accuracy: 0.001)
        XCTAssertEqual(scrollView.contentOffset.y, 30, accuracy: 0.001)

        scrollView.contentOffset = CGPoint(x: 88, y: 44)

        XCTAssertEqual(scrollView.contentOffset.x, -scrollView.adjustedContentInset.left, accuracy: 0.001)
        XCTAssertEqual(scrollView.contentOffset.y, 44, accuracy: 0.001)
    }

    func testGuardClampsHorizontalOffsetToRTLLeadingEdge() {
        let scrollView = makeOversizedScrollView(leftInset: 12, rightInset: 8)
        let guardView = attachGuardView(to: scrollView)
        guardView.isRightToLeft = true
        scrollView.contentOffset = CGPoint(x: 40, y: 30)

        guardView.attachToNearestScrollViewIfNeeded()

        // RTL leading edge is the physical right: content trailing edge meets the
        // viewport → contentSize.width + right inset - viewport width.
        let expected = scrollView.contentSize.width
            + scrollView.adjustedContentInset.right
            - scrollView.bounds.width
        XCTAssertEqual(scrollView.contentOffset.x, expected, accuracy: 0.001)
        XCTAssertEqual(scrollView.contentOffset.y, 30, accuracy: 0.001)

        scrollView.contentOffset = CGPoint(x: 120, y: 44)
        XCTAssertEqual(scrollView.contentOffset.x, expected, accuracy: 0.001)
        XCTAssertEqual(scrollView.contentOffset.y, 44, accuracy: 0.001)
    }

    func testGuardReclampsWhenContentSizeGrowsUnderRTL() {
        let scrollView = makeOversizedScrollView(rightInset: 8)
        let guardView = attachGuardView(to: scrollView)
        guardView.isRightToLeft = true
        guardView.attachToNearestScrollViewIfNeeded()

        // Growing the content width changes the RTL rest offset; observing
        // contentSize must re-clamp immediately, without a manual scroll.
        scrollView.contentSize = CGSize(width: 1_400, height: 1_200)

        let expected = 1_400 + scrollView.adjustedContentInset.right - scrollView.bounds.width
        XCTAssertEqual(scrollView.contentOffset.x, expected, accuracy: 0.001)
    }

    func testPinnedOffsetHelperLTRUsesNegativeLeftInset() {
        let x = ChatVerticalScrollAxisGuardView.pinnedHorizontalOffsetX(
            isRightToLeft: false,
            adjustedInset: UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 8),
            contentSize: CGSize(width: 900, height: 1_200),
            boundsSize: CGSize(width: 320, height: 480)
        )
        XCTAssertEqual(x, -12, accuracy: 0.001)
    }

    func testPinnedOffsetHelperRTLPinsToTrailingEdgeWhenContentOverflows() {
        let x = ChatVerticalScrollAxisGuardView.pinnedHorizontalOffsetX(
            isRightToLeft: true,
            adjustedInset: UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 8),
            contentSize: CGSize(width: 900, height: 1_200),
            boundsSize: CGSize(width: 320, height: 480)
        )
        XCTAssertEqual(x, 900 + 8 - 320, accuracy: 0.001)
    }

    func testPinnedOffsetHelperResolvesToZeroWhenTranscriptHasNoOverflowOrInset() {
        // The normal transcript case: content fits the viewport, no horizontal
        // inset — both directions rest at 0, so the toggle changes nothing here.
        let inset = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
        let content = CGSize(width: 320, height: 1_200)
        let bounds = CGSize(width: 320, height: 480)
        let ltr = ChatVerticalScrollAxisGuardView.pinnedHorizontalOffsetX(
            isRightToLeft: false, adjustedInset: inset, contentSize: content, boundsSize: bounds
        )
        let rtl = ChatVerticalScrollAxisGuardView.pinnedHorizontalOffsetX(
            isRightToLeft: true, adjustedInset: inset, contentSize: content, boundsSize: bounds
        )
        XCTAssertEqual(ltr, 0, accuracy: 0.001)
        XCTAssertEqual(rtl, 0, accuracy: 0.001)
    }

    func testGuardDetachesObserversWhenRemovedFromSuperview() {
        let scrollView = makeOversizedScrollView()
        let guardView = attachGuardView(to: scrollView)
        guardView.attachToNearestScrollViewIfNeeded()

        guardView.removeFromSuperview()
        scrollView.contentOffset = CGPoint(x: 88, y: 44)

        XCTAssertEqual(scrollView.contentOffset.x, 88, accuracy: 0.001)
        XCTAssertEqual(scrollView.contentOffset.y, 44, accuracy: 0.001)
    }

    private func makeOversizedScrollView(leftInset: CGFloat = 0, rightInset: CGFloat = 0) -> UIScrollView {
        let scrollView = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        scrollView.contentSize = CGSize(width: 900, height: 1_200)
        scrollView.contentInset = UIEdgeInsets(top: 0, left: leftInset, bottom: 0, right: rightInset)
        scrollView.alwaysBounceHorizontal = true
        scrollView.showsHorizontalScrollIndicator = true
        scrollView.isDirectionalLockEnabled = false
        return scrollView
    }

    private func attachGuardView(to scrollView: UIScrollView) -> ChatVerticalScrollAxisGuardView {
        let contentView = UIView(frame: CGRect(origin: .zero, size: scrollView.contentSize))
        let guardView = ChatVerticalScrollAxisGuardView()
        contentView.addSubview(guardView)
        scrollView.addSubview(contentView)
        return guardView
    }
}

@MainActor
final class ChatScrollPositionControllerTests: XCTestCase {
    func testLazyPrependRealizesItsDiscardedReaderBeforeUsingHeightEstimates() {
        for sample: (height: CGFloat, anchorY: CGFloat) in [(1_000, 60.0 / 520), (480, 0)] {
            let scrollView = makeScrollView()
            scrollView.contentOffset.y = 240
            let window = UIWindow(frame: scrollView.frame)
            window.addSubview(scrollView)
            window.isHidden = false
            defer { window.isHidden = true }
            let controller = ChatScrollPositionController(usesLazyLayout: true)
            controller.attach(to: scrollView)
            controller.recordRowGeometry(.init(revision: 0, contentMinY: 180,
                frame: CGRect(x: 0, y: -60, width: 300, height: sample.height)), for: "reader")
            var nativeRequests: [(String, UnitPoint)] = []
            controller.onHoldAnchor = { nativeRequests.append(($0, $1)) }
            XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
            XCTAssertTrue(controller.restoreAfterPrepend())
            controller.forgetRow("reader")
            XCTAssertEqual(nativeRequests.count, 1, "SwiftUI must realize the lazy reader it discarded")
            XCTAssertEqual(nativeRequests.first?.0, "reader")
            XCTAssertEqual(nativeRequests.first?.1.y ?? -1, sample.anchorY, accuracy: 0.001)
            scrollView.contentSize.height += 640
            XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001,
                           "A missing reader must not be replaced by an uncertain document-height estimate")
            controller.recordRowGeometry(.init(revision: 1, contentMinY: 820,
                frame: CGRect(x: 0, y: -60, width: 300, height: sample.height)), for: "reader")
            controller.rowDidAppear("reader")
            XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        }
    }

    func testLazyPrependDoesNotAdoptTheTransientViewportBeforeRestoringItsReader() {
        let scrollView = makeScrollView(isDragging: true)
        let window = UIWindow(frame: scrollView.frame)
        window.addSubview(scrollView)
        window.isHidden = false
        defer { window.isHidden = true }
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController(usesLazyLayout: true)
        controller.attach(to: scrollView)
        controller.recordRowGeometry(.init(revision: 0, contentMinY: 180,
            frame: CGRect(x: 0, y: -60, width: 300, height: 100)), for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        controller.recordRowGeometry(.init(revision: 1, contentMinY: 200,
            frame: CGRect(x: 0, y: -40, width: 300, height: 100)), for: "transient-older-row")
        controller.forgetRow("reader")
        scrollView.contentSize.height += 640
        controller.recordRowGeometry(.init(revision: 1, contentMinY: 820,
            frame: CGRect(x: 0, y: -60, width: 300, height: 100)), for: "reader")
        controller.rowDidAppear("reader")
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001,
                       "Insertion must restore its captured reader before a fling can hand it off")
    }

    func testReappearingLazyRowRestoresItsCurrentGeometryWithoutANewMeasurement() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        XCTAssertTrue(controller.capture(anchorRowID: nil, contentRevision: 1))
        controller.recordRowGeometry(.init(revision: 1, contentMinY: 180,
            frame: CGRect(x: 0, y: -60, width: 300, height: 100)), for: "reader")
        controller.forgetRow("reader")
        XCTAssertNil(controller.readingAnchorRowID)
        // Lazy cells can remount with an identical geometry value, so SwiftUI
        // sends appearance without another geometry-change action.
        controller.rowDidAppear("reader")
        XCTAssertEqual(controller.readingAnchorRowID, "reader")
    }

    func testReappearingLazyRowCannotRestoreGeometryFromAnOlderPage() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        XCTAssertTrue(controller.capture(anchorRowID: nil, contentRevision: 1))
        controller.recordRowGeometry(.init(revision: 1, contentMinY: 180,
            frame: CGRect(x: 0, y: -60, width: 300, height: 100)), for: "reader")
        controller.forgetRow("reader")
        XCTAssertTrue(controller.capture(anchorRowID: nil, contentRevision: 2))
        controller.rowDidAppear("reader")
        XCTAssertNil(controller.readingAnchorRowID, "A previous page's coordinate cannot become the current anchor")
        controller.recordRowGeometry(.init(revision: 2, contentMinY: 220,
            frame: CGRect(x: 0, y: -20, width: 300, height: 100)), for: "reader")
        XCTAssertEqual(controller.readingAnchorRowID, "reader")
    }

    func testPrependRetiresUnmeasuredFramesFromThePreviousLayout() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(220, for: "old-layout-row")
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        controller.recordRowMinY(180, for: "reader")
        XCTAssertEqual(controller.readingAnchorRowID, "reader",
                       "An unmeasured previous-layout frame must not win the next page's anchor selection")
    }

    func testLateGeometryFromADisappearedRowCannotBecomeTheReadingAnchor() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(220, for: "old-offscreen-row")
        controller.forgetRow("old-offscreen-row")
        // Lazy geometry can arrive after the row's disappearance notification.
        controller.recordRowMinY(220, for: "old-offscreen-row")
        controller.recordRowMinY(180, for: "reader")
        XCTAssertEqual(controller.readingAnchorRowID, "reader",
                       "A delayed offscreen frame must not replace the actual reader's anchor")
    }

    func testPrependReappliesAfterUIKitReanchorsTheSameInsertion() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        // Lazy layout may set its size-change anchor after the row and size callbacks.
        scrollView.contentOffset.y = 240
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001,
                       "A later structural offset must not undo the current prepend correction")
    }

    func testPrependPreservesTheReaderWhenTheDragContinuesBeforeLayout() {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))

        // The next momentum tick can precede SwiftUI's insertion layout.
        scrollView.contentOffset.y = 220
        XCTAssertEqual(scrollView.contentOffset.y, 220, accuracy: 0.001)
        scrollView.contentSize.height += 640
        controller.recordRowMinY(820, for: "reader")
        controller.contentDidLayout(revision: 1)
        XCTAssertEqual(scrollView.contentOffset.y, 860, accuracy: 0.001,
                       "An arriving page must preserve the reader's continued 20pt scroll, not jump its rows by 640pt")
    }

    func testPrependDoesNotTreatGrowthBelowTheReaderAsOlderHistory() {
        let scrollView = makeScrollView()
        scrollView.contentSize.height = 5_000
        scrollView.contentOffset.y = 300
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowGeometry(.init(revision: 0, contentMinY: 180,
            frame: CGRect(x: 0, y: -120, width: 300, height: 1_000)), for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 940
        // The page adds 640pt above; live content or media adds 300pt below.
        controller.recordRowGeometry(.init(revision: 1, contentMinY: 820,
            frame: CGRect(x: 0, y: -120, width: 300, height: 1_300)), for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 940, accuracy: 0.001,
                       "Live content below the reader must not count as older history")
    }

    func testLazyPrependBridgesInsertionUntilItsReaderIsRestored() {
        let scrollView = makeScrollView()
        let window = UIWindow(frame: scrollView.frame)
        window.addSubview(scrollView)
        window.isHidden = false
        defer { window.isHidden = true }
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController(usesLazyLayout: true)
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001,
                       "The initial insertion must bridge to the reader before its frame arrives")
        // The background can acknowledge layout before the lazy reader measures.
        controller.contentDidLayout(revision: 1)
        scrollView.contentSize.height += 100
        XCTAssertEqual(scrollView.contentOffset.y, 980, accuracy: 0.001,
                       "An early background layout must not retire the initial bridge")
        controller.recordRowMinY(920, for: "reader", contentRevision: 1)
        controller.forgetRow("reader")
        scrollView.contentSize.height += 300
        XCTAssertEqual(scrollView.contentOffset.y, 980, accuracy: 0.001,
                       "After measured restoration, document estimates must not move a missing reader")
    }

    func testPrependKeepsTheCurrentReaderWhenAFlingUnmountsTheCapturedRow() async throws {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentSize.height = 5_000
        scrollView.contentOffset.y = 1_240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(1_200, for: "original-reader")
        XCTAssertTrue(controller.capture(anchorRowID: "original-reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        controller.recordRowMinY(1_840, for: "original-reader")
        controller.recordRowMinY(1_500, for: "current-reader")
        XCTAssertEqual(scrollView.contentOffset.y, 1_880, accuracy: 0.001)
        try await Task.sleep(for: .milliseconds(10))
        scrollView.contentOffset.y = 1_680
        controller.forgetRow("original-reader")

        // The old reader left the lazy viewport. A table below the new reader
        // now replaces its estimated height; none of this growth is above them.
        scrollView.contentSize.height += 200
        controller.recordRowMinY(1_500, for: "current-reader")
        XCTAssertEqual(scrollView.contentOffset.y, 1_680, accuracy: 0.001,
                       "A fling must not switch from a measured reader to whole-document height")
    }

    func testPrependDoesNotUndoFingerMovementInTheSameTurnAsLazyMeasurement() {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)

        // UIKit can deliver the next finger tick before the run-loop flag clears.
        scrollView.panGestureRecognizer.setTranslation(CGPoint(x: 0, y: 20), in: scrollView)
        XCTAssertEqual(scrollView.panGestureRecognizer.translation(in: scrollView).y, 20)
        scrollView.contentOffset.y = 860
        XCTAssertEqual(scrollView.contentOffset.y, 860, accuracy: 0.001,
                       "Lazy measurement must not rewind the reader's continued upward drag")
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 860, accuracy: 0.001,
                       "An unchanged anchor report must not replay the old scroll position")
    }

    func testPrependKeepsFollowingLateRowMeasurementDuringAContinuedDrag() async throws {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 400
        controller.recordRowMinY(580, for: "reader")
        controller.contentDidLayout(revision: 1)
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)

        try await Task.sleep(for: .milliseconds(10))
        scrollView.contentOffset.y = 620
        scrollView.contentSize.height += 240
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 860, accuracy: 0.001,
                       "Late row measurement must preserve the ongoing gesture after the first layout acknowledgement")
    }

    func testPrependIgnoresUIKitReanchoringDuringTheDrag() async throws {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        scrollView.contentOffset.y = 880 // UIKit re-anchors before the row's geometry callback.
        controller.recordRowMinY(820, for: "reader")
        controller.contentDidLayout(revision: 1)
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001, "Count the insertion once, not as additional finger movement")
        try await Task.sleep(for: .milliseconds(10))
        scrollView.contentOffset.y = 860
        scrollView.contentSize.height += 100
        controller.recordRowMinY(920, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 960, accuracy: 0.001)
    }

    func testPrefetchAnchorsTheCurrentReaderInsteadOfAnOlderPageBelowThem() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        controller.recordRowMinY(600, for: "previous-page-first")
        XCTAssertEqual(controller.readingAnchorRowID, "reader")
        XCTAssertTrue(controller.capture(anchorRowID: controller.readingAnchorRowID))
        XCTAssertTrue(controller.restoreAfterPrepend())
        controller.recordRowMinY(580, for: "reader")
        // The prepend adds 400pt; a disclosure below the reader adds another 100pt.
        controller.recordRowMinY(1_100, for: "previous-page-first")
        scrollView.contentSize.height += 500
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)
    }

    func testPrependWaitsForItsLayoutRevisionAndDetachReleasesTheWait() async {
        let scrollView = makeScrollView()
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        XCTAssertTrue(controller.capture(anchorRowID: nil, contentRevision: 2))
        var settled = false
        let wait = Task { await controller.waitForPrependLayout(); settled = true }
        await Task.yield()
        controller.contentDidLayout(revision: 1)
        await Task.yield()
        XCTAssertFalse(settled, "An old page's layout cannot admit the next fetch")
        controller.contentDidLayout(revision: 2)
        await wait.value
        XCTAssertTrue(settled)

        XCTAssertTrue(controller.capture(anchorRowID: nil, contentRevision: 3))
        settled = false
        let detachWait = Task { await controller.waitForPrependLayout(); settled = true }
        await Task.yield()
        controller.detach()
        await detachWait.value
        XCTAssertTrue(settled, "Closing the transcript must not strand its loading task")

        controller.attach(to: scrollView)
        XCTAssertTrue(controller.capture(anchorRowID: nil, contentRevision: 4))
        settled = false
        let reattachWait = Task { await controller.waitForPrependLayout(); settled = true }
        await Task.yield()
        controller.attach(to: makeScrollView())
        await reattachWait.value
        XCTAssertTrue(settled, "Replacing the scroll view releases its old layout wait")
    }

    func testResponseTimePrependPreservesAnActiveDragThroughLateMeasurement() async throws {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertFalse(controller.restoreAfterPrepend(), "A capture made before a request must still defer to the gesture")
        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        try await Task.sleep(for: .milliseconds(10))
        scrollView.contentOffset.y = 860
        scrollView.contentSize.height += 400
        XCTAssertEqual(scrollView.contentOffset.y, 1260, accuracy: 0.001, "Late growth keeps the reader's continued movement intact")
    }

    func testPrependCompensatesByExactContentHeightGrowth() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertTrue(controller.restoreAfterPrepend())

        scrollView.contentSize.height += 640

        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testHoldPutsBackAnAnchorSwiftUIReappliesOnSizeChange() {
        // Reader parked at the exact top; a disclosure grows a row below them and
        // SwiftUI re-applies the bottom anchor. The hold restores the top.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        scrollView.contentSize.height += 640
        scrollView.contentOffset.y = scrollView.contentSize.height - scrollView.bounds.height

        XCTAssertEqual(scrollView.contentOffset.y, 0, accuracy: 0.001)
    }

    func testHoldClampsWhenARowBelowCollapses() {
        // Reader at the bottom collapses a row: the content shrinks under them, so
        // the held offset can only clamp to the new maximum.
        let scrollView = makeScrollView()
        let bottom = scrollView.contentSize.height - scrollView.bounds.height
        scrollView.contentOffset = CGPoint(x: 0, y: bottom)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        scrollView.contentSize.height -= 200

        XCTAssertEqual(scrollView.contentOffset.y, bottom - 200, accuracy: 0.001)
    }

    func testReleasedHoldLetsOffsetChangesThrough() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        controller.releaseHold()
        scrollView.contentOffset.y = 300

        XCTAssertEqual(scrollView.contentOffset.y, 300, accuracy: 0.001)
    }

    func testHoldKeepsRevertingAcrossALongRelayout() {
        // Lazy rows settle over many frames; each frame SwiftUI re-applies the
        // bottom anchor and each time the pin puts the reader back.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        for growth in [640, 400, 220, 90, 40] as [CGFloat] {
            scrollView.contentSize.height += growth
            scrollView.contentOffset.y = scrollView.contentSize.height - scrollView.bounds.height
            XCTAssertEqual(scrollView.contentOffset.y, 0, accuracy: 0.001)
        }
    }

    func testHoldKeepsItsPositionWhileTheCapturedRowIsTemporarilyUnmeasured() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        controller.holdPosition(anchorRowID: "reader") {}
        scrollView.contentSize.height += 640
        controller.recordRowMinY(580, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)
        controller.forgetRow("reader")
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001,
                       "An unmeasured row must not snap back to an obsolete absolute offset")
        controller.recordRowMinY(580, for: "reader")
        controller.rowDidAppear("reader")
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)
    }

    func testVisiblePrependDoesNotJumpToTheOldEndBeforeItsBoundsGrow() throws {
        let window = try hostWindow(Color.clear)
        let scrollView = makeScrollView()
        window.addSubview(scrollView)
        let controller = ChatScrollPositionController(usesLazyLayout: true)
        defer { controller.cancelPreservation(); scrollView.removeFromSuperview() }
        controller.attach(to: scrollView)
        scrollView.contentOffset.y = 240
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        // SwiftUI reports the inserted rows before UIKit extends its scroll bounds.
        controller.recordRowMinY(2_580, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001,
                       "Clamping to the old end would lay out a different viewport for no reason")
        scrollView.contentSize.height += 2_400
        XCTAssertEqual(scrollView.contentOffset.y, 2_640, accuracy: 0.001)
    }

    func testVisiblePrependRepairsItsOffsetBeforeTheFrameCanBeCommitted() throws {
        let window = try hostWindow(Color.clear)
        let scrollView = makeScrollView()
        window.addSubview(scrollView)
        let controller = ChatScrollPositionController(usesLazyLayout: true)
        defer { controller.cancelPreservation(); scrollView.removeFromSuperview() }
        controller.attach(to: scrollView)
        scrollView.contentOffset.y = 240
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        // Preserve the measured reader before paint, rather than trusting a lazy height estimate.
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001,
                       "A visible prepend must not submit its new rows at the old content offset")
    }

    func testLazyLayoutCompensationWaitsForTheFinalFrameInThePass() async throws {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController(usesLazyLayout: true)
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        controller.recordRowMinY(1_000, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001,
                       "A provisional lazy frame must not drive a reentrant offset correction")
        controller.recordRowMinY(820, for: "reader")
        try await Task.sleep(for: .milliseconds(10))
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testNativeHoldWaitsForChangedRowHeightBeforeAnchoring() {
        let scrollView = makeScrollView()
        let host = UIView(frame: scrollView.frame)
        host.addSubview(scrollView)
        defer { scrollView.removeFromSuperview(); _ = host }
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        let collapsed = scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 200), to: nil)
        controller.recordRowFrame(collapsed, for: "reader")
        var requests = 0
        controller.onHoldAnchor = { _, _ in requests += 1 }
        controller.holdPosition(anchorRowID: "reader", resync: {})
        controller.recordRowFrame(collapsed, for: "reader")
        XCTAssertEqual(requests, 0, "The collapsed frame cannot anchor the expanded row")
        controller.recordRowFrame(scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 300), to: nil), for: "reader")
        XCTAssertEqual(requests, 1)
    }

    func testNativeHoldPreservesOffsetInARowShorterThanTheViewport() throws {
        let scrollView = makeScrollView()
        let host = UIView(frame: scrollView.frame)
        host.addSubview(scrollView)
        defer { scrollView.removeFromSuperview(); _ = host }
        scrollView.contentOffset.y = 240
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(180, for: "reader")
        controller.recordRowFrame(scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 200), to: nil), for: "reader")
        var requestedAnchor: UnitPoint?
        controller.onHoldAnchor = { _, point in requestedAnchor = point }
        controller.holdPosition(anchorRowID: "reader", resync: {})
        controller.recordRowFrame(scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 300), to: nil), for: "reader")
        let anchor = try XCTUnwrap(requestedAnchor)
        XCTAssertEqual(anchor.y * (300 - 480), 60, accuracy: 0.001,
                       "A short row needs an anchor outside 0...1 to retain the reader's 60pt inset")
    }

    func testDisclosureCompletionRunsAfterThePositionHoldFinishes() async throws {
        let scrollView = makeScrollView()
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        var completed = 0
        controller.holdPosition(anchorRowID: nil, resync: {}, completion: {
            XCTAssertFalse(controller.isHoldingPosition)
            completed += 1
        })
        XCTAssertEqual(completed, 0)
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(completed, 1, "The disclosure suspension must end with its actual position hold")
    }

    func testCancellingThePositionHoldFinishesItsDisclosureSuspensionOnce() {
        let scrollView = makeScrollView()
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        var completed = 0
        controller.holdPosition(anchorRowID: nil, resync: {}, completion: { completed += 1 })
        controller.releaseHold()
        controller.releaseHold()
        XCTAssertEqual(completed, 1)
    }

    func testHoldResyncsSwiftUIOnlyAfterItHadToRevert() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        let resynced = expectation(description: "resync after revert")
        controller.holdPosition(anchorRowID: nil) { resynced.fulfill() }
        scrollView.contentSize.height += 640
        scrollView.contentOffset.y = scrollView.contentSize.height - scrollView.bounds.height

        wait(for: [resynced], timeout: 2)
        XCTAssertEqual(scrollView.contentOffset.y, 0, accuracy: 0.001)
    }

    func testDeliberateScrollDuringHoldReleasesItInsteadOfReverting() {
        // VoiceOver or a hardware keyboard moves the offset with no size change in
        // the same turn: that is a real scroll, and the hold must let it stand.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        scrollView.contentOffset.y = 300

        XCTAssertEqual(scrollView.contentOffset.y, 300, accuracy: 0.001)
        XCTAssertFalse(controller.isHoldingPosition)
    }

    func testResyncOnlyDescribesAHeldTop() {
        XCTAssertTrue(ChatScrollPositionController.shouldResync(
            didRevertSwiftUIOffset: true, heldOffsetY: -116, minimumOffsetY: -116
        ))
        XCTAssertFalse(ChatScrollPositionController.shouldResync(
            didRevertSwiftUIOffset: true, heldOffsetY: 240, minimumOffsetY: -116
        ))
        XCTAssertFalse(ChatScrollPositionController.shouldResync(
            didRevertSwiftUIOffset: false, heldOffsetY: -116, minimumOffsetY: -116
        ))
    }

    func testFinishedHoldDoesNotFlagTheNextPrependCaptureAsAHold() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        controller.releaseHold()
        XCTAssertTrue(controller.capture(anchorRowID: nil))

        XCTAssertFalse(controller.isHoldingPosition)
        XCTAssertTrue(controller.restoreAfterPrepend())
    }

    func testHoldArmedDuringAnInFlightPrependInvalidatesTheCapture() {
        // Load Older is awaiting the server when the reader toggles a row. The
        // hold's baseline must not be mistaken for the prepend capture once the
        // rows land, or the row's growth would be compensated as prepended
        // content.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        controller.holdPosition(anchorRowID: nil) {}

        XCTAssertFalse(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001)
    }

    func testDisclosureHoldDoesNotInterruptActivePrependCompensation() {
        // A toggle inside the post-prepend stabilization window must not strand
        // late measurement of the rows inserted above the reader.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertTrue(controller.restoreAfterPrepend())
        controller.holdPosition(anchorRowID: nil) {}

        XCTAssertFalse(controller.isHoldingPosition)
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testReleaseHoldLeavesPrependPreservationAlone() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertTrue(controller.restoreAfterPrepend())
        controller.releaseHold()
        scrollView.contentSize.height += 640

        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testPrependFollowsItsAnchorRowAndIgnoresGrowthBelowIt() {
        // Older rows land above the previous first row while a row below the
        // reader grows. Only the growth above the anchor moves the offset, and
        // the anchor's frame may arrive after the content-size change.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(60, for: "first")

        XCTAssertTrue(controller.capture(anchorRowID: "first"))
        XCTAssertTrue(controller.restoreAfterPrepend())

        scrollView.contentSize.height += 640
        controller.recordRowMinY(700, for: "first")
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)

        scrollView.contentSize.height += 300
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testHoldFollowsTheTappedRowTopNotItsOwnGrowth() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(400, for: "tapped")

        controller.holdPosition(anchorRowID: "tapped") {}
        scrollView.contentSize.height += 300
        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001)

        // A row above the tapped one settles taller.
        controller.recordRowMinY(480, for: "tapped")
        scrollView.contentSize.height += 80
        XCTAssertEqual(scrollView.contentOffset.y, 320, accuracy: 0.001)
    }

    func testDisclosureToggledDuringPrependKeepsTappedRowStationary() {
        // The reader taps a disclosure inside the one-second prepend window. Its
        // expansion must not be compensated as prepended content, while rows
        // inserted above it that finish measuring later still are.
        let scrollView = makeScrollView()
        let controller = armedPrepend(in: scrollView)
        controller.recordRowMinY(1_040, for: "tapped")

        controller.holdPosition(anchorRowID: "tapped") {}
        scrollView.contentSize.height += 300
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        XCTAssertTrue(controller.isHoldingPosition)

        controller.recordRowMinY(750, for: "first")
        controller.recordRowMinY(1_090, for: "tapped")
        scrollView.contentSize.height += 50
        XCTAssertEqual(scrollView.contentOffset.y, 930, accuracy: 0.001)
    }

    func testRowlessDisclosureDuringPrependFollowsThePrependAnchor() {
        // A control outside any row (the turn-changes card) sits below every
        // inserted row, so the previous first row still describes the reader.
        let scrollView = makeScrollView()
        let controller = armedPrepend(in: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        XCTAssertTrue(controller.isHoldingPosition)
        scrollView.contentSize.height += 300
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)

        controller.recordRowMinY(750, for: "first")
        scrollView.contentSize.height += 50
        XCTAssertEqual(scrollView.contentOffset.y, 930, accuracy: 0.001)
    }

    func testHoldArmedDuringPrependLastsUntilThePrependWindowEnds() throws {
        let start = ContinuousClock.now
        let scrollView = makeScrollView()
        let controller = armedPrepend(in: scrollView)
        controller.recordRowMinY(1_040, for: "tapped")
        controller.holdPosition(anchorRowID: "tapped") {}

        let pastQuietPeriod = expectation(description: "past the hold's quiet period")
        DispatchQueue.main.asyncAfter(deadline: .now() + ChatScrollPolicy.disclosureHoldQuietPeriod + 0.1) {
            pastQuietPeriod.fulfill()
        }
        wait(for: [pastQuietPeriod], timeout: 2)
        try XCTSkipIf(ContinuousClock.now - start >= .milliseconds(900), "The main thread stalled past the prepend window.")

        XCTAssertTrue(controller.isHoldingPosition)
        controller.recordRowMinY(1_090, for: "tapped")
        scrollView.contentSize.height += 50
        XCTAssertEqual(scrollView.contentOffset.y, 930, accuracy: 0.001)
    }

    func testCancelledPrependDoesNotMoveScrollPosition() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        controller.cancelPreservation()
        scrollView.contentSize.height += 640

        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001)
    }

    func testPrependDoesNotOverrideMovementWhileRequestIsInFlight() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        scrollView.contentOffset.y = 300

        XCTAssertFalse(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 300, accuracy: 0.001)
    }

    func testCompensatedOffsetClampsToScrollableBounds() {
        let inset = UIEdgeInsets(top: 12, left: 0, bottom: 20, right: 0)

        XCTAssertEqual(
            ChatScrollPositionController.compensatedOffsetY(
                baselineOffsetY: -12,
                anchorShift: -100,
                adjustedInset: inset,
                contentSizeHeight: 1_200,
                boundsHeight: 480
            ),
            -12,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ChatScrollPositionController.compensatedOffsetY(
                baselineOffsetY: 700,
                anchorShift: 500,
                adjustedInset: inset,
                contentSizeHeight: 1_200,
                boundsHeight: 480
            ),
            740,
            accuracy: 0.001
        )
    }

    private func makeScrollView(isDragging: Bool = false) -> UIScrollView {
        let scrollView = HistoryInteractionScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        scrollView.userIsDragging = isDragging
        scrollView.contentSize = CGSize(width: 320, height: 1_200)
        return scrollView
    }

    /// A Load Older prepend that has landed: 640pt of rows above the previous
    /// first row, compensated from 240 to 880, with its window still armed.
    private func armedPrepend(in scrollView: UIScrollView) -> ChatScrollPositionController {
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = ChatScrollPositionController()
        controller.attach(to: scrollView)
        controller.recordRowMinY(60, for: "first")
        XCTAssertTrue(controller.capture(anchorRowID: "first"))
        XCTAssertTrue(controller.restoreAfterPrepend())
        controller.recordRowMinY(700, for: "first")
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        return controller
    }
}

/// UIScrollView's interaction flags are read-only; the existing fixture needs a controllable gesture for this case.
private final class HistoryInteractionScrollView: UIScrollView {
    var userIsDragging = false
    override var isDragging: Bool { userIsDragging }
    private let historyPan = HistoryPanGestureRecognizer()
    override var panGestureRecognizer: UIPanGestureRecognizer { historyPan }

    private final class HistoryPanGestureRecognizer: UIPanGestureRecognizer {
        private var movement = CGPoint.zero
        override func translation(in view: UIView?) -> CGPoint { movement }
        override func setTranslation(_ translation: CGPoint, in view: UIView?) { movement = translation }
    }
}
