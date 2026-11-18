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

    func testGuardRestsRTLContentNarrowerThanTheViewportAtTheLeftInset() {
        // RTL rests at the trailing edge only when the content overflows; narrower content stays at the left inset.
        let scrollView = makeOversizedScrollView(leftInset: 12, rightInset: 8)
        scrollView.contentSize = CGSize(width: 200, height: 1_200)
        let guardView = attachGuardView(to: scrollView)
        guardView.isRightToLeft = true
        scrollView.contentOffset = CGPoint(x: 40, y: 30)

        guardView.attachToNearestScrollViewIfNeeded()

        XCTAssertEqual(scrollView.contentOffset.x, -12, accuracy: 0.001)
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

/// The transcript's lazy controller, as production builds it. Its preservation windows, quiet releases and row
/// realization ticks run on a test clock; a visible scroll view applies a prepend before the frame is drawn, and
/// everything else waits for the main-queue turn the controller defers its compensation to.
@MainActor
final class ChatScrollPositionControllerTests: XCTestCase {
    private let clock = ManualTestClock()
    /// One realization tick of the controller's row queue.
    private let realizationTick = Duration.milliseconds(17)
    /// Keeps each scroll view's window alive for the test.
    private var windows: [UIWindow] = []

    func testRowRealizationYieldsToNativeMomentumBetweenMeasurements() async throws {
        for hasScene in [false, true] {
            let scroll = makeScrollView(isDragging: true)
            let scene: UIWindowScene?
            if hasScene {
                let window = try hostWindow(Color.clear)
                window.addSubview(scroll)
                scene = window.windowScene
            } else {
                scene = nil
            }
            scroll.userIsDecelerating = true
            scroll.contentOffset.y = 240
            let controller = makeController(for: scroll)
            defer { scroll.removeFromSuperview() }
            controller.recordRowMinY(180, for: "reader")
            XCTAssertTrue(controller.capture(anchorRowID: "reader"))
            XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
            var realized = 0
            for id in ["first", "second"] {
                controller.enqueueRowRealization(id: id, priority: 0) {
                    realized += 1
                    controller.recordRowMinY(180 + CGFloat(realized * 100), for: "reader")
                    scroll.contentSize.height += 100
                }
            }
            // Coasting rows are admitted from the scene's update link; without a scene, from the queue's own tick.
            let realizationPass = { [clock, realizationTick] in
                if let scene { await self.awaitDisplayUpdates(2, in: scene) } else { await clock.advance(by: realizationTick) }
            }
            await realizationPass()
            XCTAssertEqual(realized, 0, "Offscreen rendering must let the native momentum tick run first")
            scroll.contentOffset.y -= 20
            await realizationPass()
            XCTAssertEqual(realized, 1)
            await realizationPass()
            XCTAssertEqual(realized, 1, "Own measurement compensation must not admit another row ahead of native movement")
            scroll.contentOffset.y -= 20
            await realizationPass()
            XCTAssertEqual(realized, 2)
            controller.enqueueRowRealization(id: "after-coast", priority: 0) { realized += 1 }
            scroll.userIsDecelerating = false
            await clock.advance(by: realizationTick)
            XCTAssertEqual(realized, 3, "Ending momentum must release queued rendering without another offset event")
        }
    }

    func testExcerptHoldKeepsActiveHistoryPreservation() {
        for coasting in [false, true] {
            let scroll = makeScrollView()
            scroll.userIsDecelerating = coasting
            scroll.contentOffset.y = 240
            let controller = makeController(for: scroll)
            controller.recordRowMinY(180, for: "reader")
            XCTAssertTrue(controller.capture(anchorRowID: "reader"))
            XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
            controller.holdVisiblePosition(resync: {})
            XCTAssertTrue(controller.isPreservingPosition,
                          "Excerpt updates must retain active history preservation during momentum")
            XCTAssertFalse(controller.isHoldingPosition,
                           "Excerpt updates must not replace the existing history owner")
            scroll.contentSize.height += 640
            controller.recordRowMinY(820, for: "reader")
            XCTAssertEqual(scroll.contentOffset.y, 880, accuracy: 0.001,
                           "History must keep compensating measurement after an excerpt update")
        }
    }

    func testNativeMomentumContinuesDuringTheSameTurnAsRowMeasurement() {
        let scroll = makeScrollView(isDragging: true)
        scroll.userIsDecelerating = true
        scroll.contentOffset.y = 240
        let controller = makeController(for: scroll)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader"))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scroll.contentSize.height += 640
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scroll.contentOffset.y, 880, accuracy: 0.001)
        // UIKit's drag flag can remain true after touch-up. A native momentum
        // tick in this size-changing turn must still advance the reader.
        scroll.contentOffset.y = 860
        XCTAssertEqual(scroll.contentOffset.y, 860, accuracy: 0.001,
                       "Row measurement must not put native momentum back at its previous offset")
        controller.recordRowMinY(840, for: "reader")
        XCTAssertEqual(scroll.contentOffset.y, 880, accuracy: 0.001,
                       "The next measurement must retain the reader's continued 20pt scroll")
    }

    func testLateRealizationKeepsPreservationThroughItsMeasurement() async {
        let scroll = makeScrollView()
        scroll.contentOffset.y = 200
        let controller = makeController(for: scroll)
        controller.recordRowGeometry(.init(revision: 0, contentMinY: 200,
            frame: CGRect(x: 0, y: 0, width: 320, height: 200)), for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader"))
        XCTAssertTrue(controller.restoreAfterPrepend())
        await clock.advance(by: .milliseconds(850))
        XCTAssertTrue(controller.isPreservingPosition, "Admit the neighbor before the original prepend deadline")
        // A queued neighbor starts realizing before the prepend window ends,
        // but its measured height arrives after that original deadline.
        _ = controller.preserveReaderForRealization(isFollowingLatest: false)
        await clock.advance(by: .milliseconds(300))
        controller.recordRowMinY(62.333333333, for: "reader")
        scroll.contentSize.height -= 137.666666667
        XCTAssertEqual(scroll.contentOffset.y, 62.333333333, accuracy: 0.001,
                       "Late row measurement must preserve the reader after the original prepend deadline")
    }

    func testUserInteractionReleasesUnfinishedNavigationBeforeRealizingRows() async {
        for disclosure in [false, true] {
            let scroll = makeScrollView()
            scroll.contentOffset.y = 200
            let controller = makeController(for: scroll)
            controller.recordRowGeometry(.init(revision: 0, contentMinY: 200,
                frame: scroll.convert(CGRect(x: 0, y: 200, width: 320, height: 100), to: nil)), for: "reader")
            controller.recordRowGeometry(.init(revision: 0, contentMinY: 700,
                frame: scroll.convert(CGRect(x: 0, y: 700, width: 320, height: 100), to: nil)), for: "destination")
            controller.prepareNativeScroll(revision: 1, targetID: "destination", anchor: .top)
            var realized = 0
            controller.enqueueRowRealization(id: "neighbor", priority: 0) { realized += 1 }
            if disclosure { controller.holdPosition(anchorRowID: "reader", resync: {}) }
            else { controller.userDidBeginDragging() }
            await clock.advance(by: realizationTick)
            XCTAssertEqual(realized, 1, "A user's disclosure or drag must not wait for an abandoned navigation")
        }
    }

    func testNativeScrollAcknowledgementWaitsForTheMeasuredDestination() async {
        let destinations: [(CGFloat, UnitPoint, CGFloat)] = [
            (100, .top, 100), (100, .bottom, 0), (1_100, .top, 720),
            (100, UnitPoint(x: 0.5, y: -3.5), 720)
        ]
        for (rowY, anchor, destination) in destinations {
            let scroll = makeScrollView()
            scroll.contentOffset.y = 700
            let controller = makeController(for: scroll)
            controller.recordRowGeometry(.init(revision: 0, contentMinY: rowY,
                frame: scroll.convert(CGRect(x: 0, y: rowY, width: 320, height: 100), to: nil)), for: "destination")
            controller.prepareNativeScroll(revision: 1, targetID: "destination", anchor: anchor)
            var realized = 0
            controller.enqueueRowRealization(id: "neighbor", priority: 0) { realized += 1 }
            controller.contentDidLayout(revision: 0, nativeScrollRevision: 1)
            await clock.advance(by: realizationTick)
            XCTAssertEqual(realized, 0, "Layout alone cannot admit neighbors while the old viewport is still visible")
            scroll.contentOffset.y = destination
            controller.recordRowGeometry(.init(revision: 0, contentMinY: rowY,
                frame: scroll.convert(CGRect(x: 0, y: rowY, width: 320, height: 100), to: nil)), for: "destination")
            controller.contentDidLayout(revision: 0, nativeScrollRevision: 1)
            await clock.advance(by: realizationTick)
            XCTAssertEqual(realized, 1, "Reaching the measured destination must release queued neighbors")
        }
    }

    func testNativeScrollLayoutBlocksRealizationUntilItsMatchingAcknowledgement() async {
        let controller = makeController(for: makeScrollView())
        var realized = 0
        controller.prepareNativeScroll(revision: 1)
        controller.enqueueRowRealization(id: "pending-row", priority: 0) { realized += 1 }
        await clock.advance(by: realizationTick)
        XCTAssertEqual(realized, 0, "A new command must establish its viewport before neighbors change height")
        controller.contentDidLayout(revision: 0, nativeScrollRevision: 0)
        await clock.advance(by: realizationTick)
        XCTAssertEqual(realized, 0)
        controller.prepareNativeScroll(revision: 2)
        controller.contentDidLayout(revision: 0, nativeScrollRevision: 1)
        await clock.advance(by: realizationTick)
        XCTAssertEqual(realized, 0, "An obsolete command's acknowledgement cannot admit the next command's rows")
        controller.contentDidLayout(revision: 0, nativeScrollRevision: 2)
        await clock.advance(by: realizationTick)
        XCTAssertEqual(realized, 1, "Matching layout must resume the queued row")
    }

    func testRealizationPreservesTheVisibleRowWhenViewportStartsInSpacing() {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 110
        let controller = makeController(for: scrollView)
        controller.recordRowGeometry(.init(revision: 0, contentMinY: 0,
            frame: CGRect(x: 0, y: -110, width: 320, height: 100)), for: "above-gap")
        controller.recordRowGeometry(.init(revision: 0, contentMinY: 120,
            frame: CGRect(x: 0, y: 10, width: 320, height: 200)), for: "reader")
        XCTAssertEqual(controller.readingAnchorRowID, "reader")
        XCTAssertTrue(controller.preserveReaderForRealization(isFollowingLatest: false))
        controller.recordRowMinY(270, for: "reader")
        scrollView.contentSize.height += 150
        XCTAssertEqual(scrollView.contentOffset.y, 260, accuracy: 0.001,
                       "Realizing content above a visible row must preserve it even when the viewport begins in spacing")
    }

    func testLazyPrependRealizesItsDiscardedReaderBeforeUsingHeightEstimates() {
        for sample: (height: CGFloat, anchorY: CGFloat) in [(1_000, 60.0 / 520), (480, 0)] {
            let scrollView = makeScrollView()
            scrollView.contentOffset.y = 240
            let controller = makeController(for: scrollView)
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
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
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

    func testPrependKeepsTheCurrentReaderWhenAFlingUnmountsTheCapturedRow() async {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentSize.height = 5_000
        scrollView.contentOffset.y = 1_240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(1_200, for: "original-reader")
        XCTAssertTrue(controller.capture(anchorRowID: "original-reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        controller.recordRowMinY(1_840, for: "original-reader")
        controller.recordRowMinY(1_500, for: "current-reader")
        XCTAssertEqual(scrollView.contentOffset.y, 1_880, accuracy: 0.001)
        await nextTurn()
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
        let controller = makeController(for: scrollView)
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

    func testPrependKeepsFollowingLateRowMeasurementDuringAContinuedDrag() async {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 400
        controller.recordRowMinY(580, for: "reader")
        controller.contentDidLayout(revision: 1)
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)

        await nextTurn()
        scrollView.contentOffset.y = 620
        scrollView.contentSize.height += 240
        controller.recordRowMinY(820, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 860, accuracy: 0.001,
                       "Late row measurement must preserve the ongoing gesture after the first layout acknowledgement")
    }

    func testPrependIgnoresUIKitReanchoringDuringTheDrag() async {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        scrollView.contentOffset.y = 880 // UIKit re-anchors before the row's geometry callback.
        controller.recordRowMinY(820, for: "reader")
        controller.contentDidLayout(revision: 1)
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001, "Count the insertion once, not as additional finger movement")
        await nextTurn()
        scrollView.contentOffset.y = 860
        scrollView.contentSize.height += 100
        controller.recordRowMinY(920, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 960, accuracy: 0.001)
    }

    func testPrefetchAnchorsTheCurrentReaderInsteadOfAnOlderPageBelowThem() {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
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
        let controller = makeController(for: scrollView)
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

    func testResponseTimePrependPreservesAnActiveDragThroughLateMeasurement() async {
        let scrollView = makeScrollView(isDragging: true)
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertFalse(controller.restoreAfterPrepend(), "A capture made before a request must still defer to the gesture")
        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertTrue(controller.restoreAfterPrepend(whileInteracting: true))
        scrollView.contentSize.height += 640
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        await nextTurn()
        scrollView.contentOffset.y = 860
        scrollView.contentSize.height += 400
        XCTAssertEqual(scrollView.contentOffset.y, 1260, accuracy: 0.001, "Late growth keeps the reader's continued movement intact")
    }

    func testPrependCompensatesByExactContentHeightGrowth() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = makeController(for: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        XCTAssertTrue(controller.restoreAfterPrepend())

        scrollView.contentSize.height += 640

        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testHoldClampsWhenARowBelowCollapses() async {
        // Reader at the bottom collapses a row: the content shrinks under them, so
        // the held offset can only clamp to the new maximum.
        let scrollView = makeScrollView()
        let bottom = scrollView.contentSize.height - scrollView.bounds.height
        scrollView.contentOffset = CGPoint(x: 0, y: bottom)
        let controller = makeController(for: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        scrollView.contentSize.height -= 200
        await nextTurn()

        XCTAssertEqual(scrollView.contentOffset.y, bottom - 200, accuracy: 0.001)
    }

    func testReleasedHoldLetsOffsetChangesThrough() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = makeController(for: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        controller.releaseHold()
        scrollView.contentOffset.y = 300

        XCTAssertEqual(scrollView.contentOffset.y, 300, accuracy: 0.001)
    }

    func testHoldKeepsRevertingAcrossALongRelayout() async {
        // Lazy rows settle over many frames; each frame SwiftUI re-applies the
        // bottom anchor and each time the pin puts the reader back.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = makeController(for: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        for growth in [640, 400, 220, 90, 40] as [CGFloat] {
            scrollView.contentSize.height += growth
            scrollView.contentOffset.y = scrollView.contentSize.height - scrollView.bounds.height
            await nextTurn()
            XCTAssertEqual(scrollView.contentOffset.y, 0, accuracy: 0.001)
        }
    }

    func testHoldKeepsItsPositionWhileTheCapturedRowIsTemporarilyUnmeasured() async {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(180, for: "reader")
        controller.holdPosition(anchorRowID: "reader") {}
        scrollView.contentSize.height += 640
        controller.recordRowMinY(580, for: "reader")
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)
        controller.forgetRow("reader")
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001,
                       "An unmeasured row must not snap back to an obsolete absolute offset")
        controller.recordRowMinY(580, for: "reader")
        controller.rowDidAppear("reader")
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 640, accuracy: 0.001)
    }

    func testVisiblePrependDoesNotJumpToTheOldEndBeforeItsBoundsGrow() throws {
        let window = try hostWindow(Color.clear)
        let scrollView = makeScrollView()
        window.addSubview(scrollView)
        let controller = makeController(for: scrollView)
        defer { controller.cancelPreservation(); scrollView.removeFromSuperview() }
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
        let controller = makeController(for: scrollView)
        defer { controller.cancelPreservation(); scrollView.removeFromSuperview() }
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

    func testLazyLayoutCompensationWaitsForTheFinalFrameInThePass() async {
        let scrollView = makeScrollView(inWindow: false)
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(180, for: "reader")
        XCTAssertTrue(controller.capture(anchorRowID: "reader", contentRevision: 1))
        XCTAssertTrue(controller.restoreAfterPrepend())
        scrollView.contentSize.height += 640
        controller.recordRowMinY(1_000, for: "reader")
        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001,
                       "A provisional lazy frame must not drive a reentrant offset correction")
        controller.recordRowMinY(820, for: "reader")
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testNativeHoldWaitsForChangedRowHeightBeforeAnchoring() async {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(180, for: "reader")
        let collapsed = scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 200), to: nil)
        controller.recordRowFrame(collapsed, for: "reader")
        var requests = 0
        controller.onHoldAnchor = { _, _ in requests += 1 }
        controller.holdPosition(anchorRowID: "reader", resync: {})
        controller.recordRowFrame(collapsed, for: "reader")
        await nextTurn()
        XCTAssertEqual(requests, 0, "The collapsed frame cannot anchor the expanded row")
        controller.recordRowFrame(scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 300), to: nil), for: "reader")
        await nextTurn()
        XCTAssertEqual(requests, 1)
    }

    func testNativeHoldPreservesOffsetInARowShorterThanTheViewport() async throws {
        let scrollView = makeScrollView()
        scrollView.contentOffset.y = 240
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(180, for: "reader")
        controller.recordRowFrame(scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 200), to: nil), for: "reader")
        var requestedAnchor: UnitPoint?
        controller.onHoldAnchor = { _, point in requestedAnchor = point }
        controller.holdPosition(anchorRowID: "reader", resync: {})
        controller.recordRowFrame(scrollView.convert(CGRect(x: 0, y: 180, width: 320, height: 300), to: nil), for: "reader")
        await nextTurn()
        let anchor = try XCTUnwrap(requestedAnchor)
        XCTAssertEqual(anchor.y * (300 - 480), 60, accuracy: 0.001,
                       "A short row needs an anchor outside 0...1 to retain the reader's 60pt inset")
    }

    func testDisclosureCompletionRunsAfterThePositionHoldFinishes() async {
        let controller = makeController(for: makeScrollView())
        var completed = 0
        controller.holdPosition(anchorRowID: nil, resync: {}, completion: {
            XCTAssertFalse(controller.isHoldingPosition)
            completed += 1
        })
        XCTAssertEqual(completed, 0)
        await clock.advance(by: .seconds(ChatScrollPolicy.disclosureHoldQuietPeriod))
        XCTAssertEqual(completed, 1, "The disclosure suspension must end with its actual position hold")
    }

    func testCancellingThePositionHoldFinishesItsDisclosureSuspensionOnce() {
        let controller = makeController(for: makeScrollView())
        var completed = 0
        controller.holdPosition(anchorRowID: nil, resync: {}, completion: { completed += 1 })
        controller.releaseHold()
        controller.releaseHold()
        XCTAssertEqual(completed, 1)
    }

    /// SwiftUI's own scroll resyncs it only after the hold put back an offset SwiftUI applied, and only at the top:
    /// that scroll goes to the transcript's top.
    func testHoldResyncsSwiftUIOnlyAfterItHadToRevertAtTheTop() async {
        for (start, revert, expected) in [(CGFloat(0), true, true), (0, false, false), (240, true, false)] {
            let scrollView = makeScrollView()
            scrollView.contentOffset = CGPoint(x: 0, y: start)
            let controller = makeController(for: scrollView)
            var resynced = false
            controller.holdPosition(anchorRowID: nil) { resynced = true }
            scrollView.contentSize.height += 640
            // SwiftUI re-applies the bottom anchor on the size change.
            if revert { scrollView.contentOffset.y = scrollView.contentSize.height - scrollView.bounds.height }
            await nextTurn()
            XCTAssertEqual(scrollView.contentOffset.y, start, accuracy: 0.001)
            await clock.advance(by: .seconds(ChatScrollPolicy.disclosureHoldQuietPeriod))
            XCTAssertFalse(controller.isHoldingPosition)
            XCTAssertEqual(resynced, expected, "start \(start), reverted \(revert)")
        }
    }

    func testDeliberateScrollDuringHoldReleasesItInsteadOfReverting() {
        // VoiceOver or a hardware keyboard moves the offset with no size change in
        // the same turn: that is a real scroll, and the hold must let it stand.
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 0)
        let controller = makeController(for: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        scrollView.contentOffset.y = 300

        XCTAssertEqual(scrollView.contentOffset.y, 300, accuracy: 0.001)
        XCTAssertFalse(controller.isHoldingPosition)
    }

    func testFinishedHoldDoesNotFlagTheNextPrependCaptureAsAHold() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = makeController(for: scrollView)

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
        let controller = makeController(for: scrollView)

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
        let controller = makeController(for: scrollView)

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
        let controller = makeController(for: scrollView)

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
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(60, for: "first")

        XCTAssertTrue(controller.capture(anchorRowID: "first"))
        XCTAssertTrue(controller.restoreAfterPrepend())

        scrollView.contentSize.height += 640
        controller.recordRowMinY(700, for: "first")
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)

        scrollView.contentSize.height += 300
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
    }

    func testHoldFollowsTheTappedRowTopNotItsOwnGrowth() async {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = makeController(for: scrollView)
        controller.recordRowMinY(400, for: "tapped")

        controller.holdPosition(anchorRowID: "tapped") {}
        scrollView.contentSize.height += 300
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001)

        // A row above the tapped one settles taller.
        controller.recordRowMinY(480, for: "tapped")
        scrollView.contentSize.height += 80
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 320, accuracy: 0.001)
    }

    func testDisclosureToggledDuringPrependKeepsTappedRowStationary() async {
        // The reader taps a disclosure inside the one-second prepend window. Its
        // expansion must not be compensated as prepended content, while rows
        // inserted above it that finish measuring later still are.
        let scrollView = makeScrollView()
        let controller = armedPrepend(in: scrollView)
        controller.recordRowMinY(1_040, for: "tapped")

        controller.holdPosition(anchorRowID: "tapped") {}
        scrollView.contentSize.height += 300
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)
        XCTAssertTrue(controller.isHoldingPosition)

        controller.recordRowMinY(750, for: "first")
        controller.recordRowMinY(1_090, for: "tapped")
        scrollView.contentSize.height += 50
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 930, accuracy: 0.001)
    }

    func testRowlessDisclosureDuringPrependFollowsThePrependAnchor() async {
        // A control outside any row (the turn-changes card) sits below every
        // inserted row, so the previous first row still describes the reader.
        let scrollView = makeScrollView()
        let controller = armedPrepend(in: scrollView)

        controller.holdPosition(anchorRowID: nil) {}
        XCTAssertTrue(controller.isHoldingPosition)
        scrollView.contentSize.height += 300
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 880, accuracy: 0.001)

        controller.recordRowMinY(750, for: "first")
        scrollView.contentSize.height += 50
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 930, accuracy: 0.001)
    }

    func testHoldArmedDuringPrependLastsUntilThePrependWindowEnds() async {
        let scrollView = makeScrollView()
        let controller = armedPrepend(in: scrollView)
        controller.recordRowMinY(1_040, for: "tapped")
        controller.holdPosition(anchorRowID: "tapped") {}

        await clock.advance(by: .seconds(ChatScrollPolicy.disclosureHoldQuietPeriod) + .milliseconds(100))
        XCTAssertTrue(controller.isHoldingPosition, "A hold armed inside the prepend window outlasts its quiet period")
        controller.recordRowMinY(1_090, for: "tapped")
        scrollView.contentSize.height += 50
        await nextTurn()
        XCTAssertEqual(scrollView.contentOffset.y, 930, accuracy: 0.001)

        await clock.advance(by: .seconds(1))
        XCTAssertFalse(controller.isHoldingPosition, "The hold releases once the prepend window has ended")
    }

    func testCancelledPrependDoesNotMoveScrollPosition() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = makeController(for: scrollView)

        XCTAssertTrue(controller.capture(anchorRowID: nil))
        controller.cancelPreservation()
        scrollView.contentSize.height += 640

        XCTAssertEqual(scrollView.contentOffset.y, 240, accuracy: 0.001)
    }

    func testPrependDoesNotOverrideMovementWhileRequestIsInFlight() {
        let scrollView = makeScrollView()
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = makeController(for: scrollView)

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

    private func makeController(for scrollView: UIScrollView) -> ChatScrollPositionController {
        let controller = ChatScrollPositionController(clock: clock)
        controller.attach(to: scrollView)
        // Ends the clock's sleeping windows and realization tasks with the test.
        addTeardownBlock { MainActor.assumeIsolated { controller.detach() } }
        return controller
    }

    /// The transcript's scroll view is on screen, as it is when a page lands; `inWindow: false` is a detached layout.
    private func makeScrollView(isDragging: Bool = false, inWindow: Bool = true) -> HistoryInteractionScrollView {
        let scrollView = HistoryInteractionScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        scrollView.userIsDragging = isDragging
        scrollView.contentSize = CGSize(width: 320, height: 1_200)
        if inWindow {
            let window = UIWindow(frame: scrollView.frame)
            window.addSubview(scrollView)
            windows.append(window)
        }
        return scrollView
    }

    /// The main-queue turn a lazy layout's deferred compensation runs in, as production's next pass does.
    private func nextTurn() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    /// A Load Older prepend that has landed: 640pt of rows above the previous
    /// first row, compensated from 240 to 880, with its window still armed.
    private func armedPrepend(in scrollView: UIScrollView) -> ChatScrollPositionController {
        scrollView.contentOffset = CGPoint(x: 0, y: 240)
        let controller = makeController(for: scrollView)
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
    var userIsDecelerating = false
    override var isDragging: Bool { userIsDragging }
    override var isDecelerating: Bool { userIsDecelerating }
    private let historyPan = HistoryPanGestureRecognizer()
    override var panGestureRecognizer: UIPanGestureRecognizer { historyPan }

    private final class HistoryPanGestureRecognizer: UIPanGestureRecognizer {
        private var movement = CGPoint.zero
        override func translation(in view: UIView?) -> CGPoint { movement }
        override func setTranslation(_ translation: CGPoint, in view: UIView?) { movement = translation }
    }
}

@MainActor
final class ChatTranscriptRowCacheTests: XCTestCase {
    func testWindowBoundsLayoutNodesWithoutChangingDocumentExtent() {
        let cache = ChatTranscriptRowCache()
        let ids = (0..<1_000).map { "row-\($0)" }
        for top: CGFloat in [0, 50_000, 199_000] {
            let elements = cache.elements(ids: ids, top: top, viewportHeight: 600,
                                          spacing: 12, pinned: ["row-400"], freezesWindow: false)
            XCTAssertLessThan(elements.count, 24, "Layout nodes must depend on the viewport, not loaded history")
            XCTAssertEqual(extent(elements, cache: cache), 200_000 + 999 * 12, accuracy: 0.001)
        }
    }

    func testFrozenPrependUsesOnePrefixSpacerAndRetainsReaderIdentityAndState() {
        let cache = ChatTranscriptRowCache()
        let ids = (50..<100).map { "row-\($0)" }
        let state = cache.state(for: "row-59")
        cache.record(height: 2_400, for: "row-59")
        let before = cache.elements(ids: ids, top: 0, viewportHeight: 600,
                                    spacing: 12, pinned: ["row-59"], freezesWindow: true)
        let after = cache.elements(ids: (0..<100).map { "row-\($0)" }, top: 0, viewportHeight: 600,
                                   spacing: 12, pinned: ["row-59"], freezesWindow: true)
        XCTAssertEqual(after.count, before.count)
        XCTAssertEqual(extent(after, cache: cache) - extent(before, cache: cache), 50 * 212, accuracy: 0.001)
        XCTAssertEqual(before.filter { if case .row = $0 { return true }; return false }.map(\.id),
                       after.filter { if case .row = $0 { return true }; return false }.map(\.id))
        XCTAssertTrue(state === cache.state(for: "row-59"))
        let previousExtent = extent(before, cache: cache)
        cache.record(height: 3_000, for: "row-59")
        let remeasured = cache.elements(ids: ids, top: 0, viewportHeight: 600,
                                       spacing: 12, pinned: [], freezesWindow: true)
        XCTAssertEqual(extent(remeasured, cache: cache), previousExtent + 600, accuracy: 0.001)
        XCTAssertTrue(state === cache.state(for: "row-59"), "Removing a row wrapper must retain its device-local state")
    }

    private func extent(_ elements: [ChatTranscriptRowCache.Element], cache: ChatTranscriptRowCache) -> CGFloat {
        elements.reduce(CGFloat(max(0, elements.count - 1)) * 12) { sum, element in
            switch element {
            case let .row(_, id): sum + cache.height(for: id)
            case let .gap(_, _, height): sum + height
            }
        }
    }
}
