import SwiftUI
import UIKit
import TalariaKit

struct ChatScrollMetrics: Equatable {
    let distanceFromBottom: CGFloat
    let isUserInteracting: Bool
    /// A scroll with no gesture carried the reader away from the bottom since
    /// the last delivered report; see `ChatScrollPolicy.isScrollingAwayFromBottom`.
    let movedAwayFromBottom: Bool
}


/// Keeps the reader's exact vertical position through a layout change SwiftUI
/// would otherwise move them for. Two cases:
///
/// - **Prepend.** Older rows are inserted above the reader; the offset follows
///   the previous first row down. `ScrollViewProxy.scrollTo(_:anchor:)` can only
///   align a row to a coarse anchor, which loses the gap formerly occupied by
///   the Load Older button and causes a visible hop.
/// - **Hold.** A disclosure toggle grows or shrinks the tapped row; the offset
///   follows only that row's top. SwiftUI can re-apply a default anchor on
///   that size change (seen at the exact top after a status-bar scroll); that
///   shows up as an offset change in the same run-loop turn as a size change
///   and is put back. Any other offset change is someone scrolling on purpose
///   (VoiceOver, a hardware keyboard, a follow scroll) and releases the hold.
///
/// Both cases anchor on a row's reported content-space top rather than on the
/// transcript's total height, so growth above the anchor (prepended rows still
/// measuring) moves the offset and growth below it (a disclosure expanding)
/// does not. That is what lets a toggle inside the prepend window pin the
/// tapped row without stranding the inserted rows' late measurement.
///
/// The controller snapshots the UIKit scroll geometry, then corrects during
/// the following layout passes for a bounded window. Corrections are
/// deliberately non-animated: they preserve an existing position rather than
/// navigating to a new one. Any user movement releases the hold.
@MainActor
final class ChatScrollPositionController {
    private enum Mode {
        /// Offset follows the anchor row, or the net content-height growth
        /// without one.
        case prepend
        /// Offset follows only the anchor row; SwiftUI-driven offset changes
        /// are reverted.
        case hold
    }

    private weak var scrollView: UIScrollView?
    private var mode = Mode.prepend
    /// Set by `capture()`, cleared by anything that replaces the baseline, so
    /// a hold armed while the older-message request is in flight cannot be
    /// mistaken for the prepend capture when the request lands.
    private var hasPrependCapture = false
    private var baselineContentHeight: CGFloat?
    private var baselineOffsetY: CGFloat?
    private var contentSizeObservation: NSKeyValueObservation?
    private var contentOffsetObservation: NSKeyValueObservation?
    private var completionTask: Task<Void, Never>?
    private var quietReleaseTask: Task<Void, Never>?
    private var isApplyingCompensation = false
    /// Set when a hold had to undo an offset SwiftUI applied. SwiftUI's own
    /// notion of the offset is then stale, and lazy rows it believes are
    /// off-screen stop hit-testing until a scroll it performed itself resyncs
    /// it; `resyncAfterHold` is that scroll.
    private var didRevertSwiftUIOffset = false
    private var resyncAfterHold: (() -> Void)?
    /// True from a content-size change until the end of the same run-loop
    /// turn: an offset change in that window is SwiftUI re-anchoring, not a
    /// scroll. `lastObservedContentHeight` covers the offset change UIKit
    /// makes from inside the content-size setter, before that callback runs.
    private var contentSizeChangedThisTurn = false
    private var lastObservedContentHeight: CGFloat?
    /// Each transcript row's top in content coordinates, as the rows report it.
    private var rowMinY: [String: CGFloat] = [:]
    /// The row whose top the preserved position travels with.
    private var anchor: (rowID: String, baselineMinY: CGFloat)?
    /// End of `restoreAfterPrepend()`'s window. A hold armed inside it lasts at
    /// least this long, so late measurement of the inserted rows is absorbed.
    private var prependWindowEnd: ContinuousClock.Instant?

    var isHoldingPosition: Bool {
        mode == .hold && baselineOffsetY != nil
    }

    /// True only while `restoreAfterPrepend()`'s bounded window is armed. A bare
    /// `capture()` awaiting the server does not qualify: a toggle then invalidates
    /// it, because the rows have not landed and its baseline no longer describes
    /// the layout the reader is looking at.
    private var isCompensatingPrepend: Bool {
        mode == .prepend && contentSizeObservation != nil
    }

    func attach(to scrollView: UIScrollView) {
        guard scrollView !== self.scrollView else { return }
        cancelPreservation()
        self.scrollView = scrollView
    }

    func detach() {
        cancelPreservation()
        scrollView = nil
    }

    /// Records where a transcript row's top sits in content coordinates. The
    /// anchor row's report re-applies the preserved position, since SwiftUI
    /// can deliver it after the content-size change it belongs to.
    func recordRowMinY(_ minY: CGFloat, for rowID: String) {
        rowMinY[rowID] = minY
        reapplyIfAnchor(rowID)
    }

    func forgetRow(_ rowID: String) {
        rowMinY[rowID] = nil
        reapplyIfAnchor(rowID)
    }

    private func reapplyIfAnchor(_ rowID: String) {
        guard rowID == anchor?.rowID, contentSizeObservation != nil else { return }
        applyCompensation()
    }

    /// Snapshots the position before older rows are requested. `anchorRowID`
    /// is the current first row; without a reported frame for it the prepend
    /// falls back to net content-height growth.
    @discardableResult
    func capture(anchorRowID: String?) -> Bool {
        cancelPreservation()
        guard let scrollView else { return false }

        baselineContentHeight = scrollView.contentSize.height
        baselineOffsetY = scrollView.contentOffset.y
        anchor = anchorRowID.flatMap(anchorSnapshot)
        hasPrependCapture = true
        return true
    }

    private func anchorSnapshot(_ rowID: String) -> (rowID: String, baselineMinY: CGFloat)? {
        rowMinY[rowID].map { (rowID, $0) }
    }

    /// Arms compensation before SwiftUI performs the prepend layout. Returns
    /// false when the user moved the scroll view while the request was in
    /// flight, or a disclosure hold replaced the capture meanwhile, leaving the
    /// caller free to use its coarse fallback instead of overriding movement it
    /// does not own.
    @discardableResult
    func restoreAfterPrepend() -> Bool {
        guard hasPrependCapture,
              let scrollView,
              let baselineOffsetY,
              baselineContentHeight != nil,
              !scrollView.isDragging,
              !scrollView.isTracking,
              !scrollView.isDecelerating,
              abs(scrollView.contentOffset.y - baselineOffsetY) <= 1
        else {
            cancelPreservation()
            return false
        }

        // Text and attachment layout can settle over several run-loop passes.
        // Keep following the anchor for a short bounded window, then release
        // ownership back to normal scrolling.
        let window: TimeInterval = 1
        beginPreservation(mode: .prepend, scrollView: scrollView, window: window)
        prependWindowEnd = .now + .seconds(window)
        return true
    }

    /// Pins the reader to the tapped row (`anchorRowID`): a disclosure inside it
    /// is about to change its height. The pin releases once the content size has
    /// been quiet for `ChatScrollPolicy.disclosureHoldQuietPeriod`, or after
    /// `disclosureHoldMaximum` at the latest. No-op while the user is moving the
    /// transcript; their gesture owns the position.
    func holdPosition(anchorRowID: String?, resync: @escaping () -> Void) {
        // Inside a prepend window, rows inserted above the reader may still be
        // measuring. The pin keeps following them through its anchor: the tapped
        // row, or for a control outside any row (always below the inserted
        // rows) the prepend's own anchor. Without either, a pin would freeze the
        // offset under that growth, so let the prepend window finish; the bottom
        // size-change anchor is suspended for the toggle either way.
        let carriedPrependWindowEnd = isCompensatingPrepend ? prependWindowEnd : nil
        let prependAnchorID = carriedPrependWindowEnd == nil ? nil : anchor?.rowID
        let holdAnchor = anchorRowID.flatMap(anchorSnapshot) ?? prependAnchorID.flatMap(anchorSnapshot)
        guard carriedPrependWindowEnd == nil || holdAnchor != nil else { return }
        cancelPreservation()
        guard let scrollView,
              !scrollView.isDragging,
              !scrollView.isTracking,
              !scrollView.isDecelerating
        else { return }

        baselineOffsetY = scrollView.contentOffset.y
        anchor = holdAnchor
        prependWindowEnd = carriedPrependWindowEnd
        lastObservedContentHeight = scrollView.contentSize.height
        resyncAfterHold = resync
        beginPreservation(mode: .hold, scrollView: scrollView, window: ChatScrollPolicy.disclosureHoldMaximum)
        scheduleQuietRelease()
    }

    /// Hold ran to completion (quiet or capped): let go, then resync SwiftUI
    /// if the hold had to fight it. A hold ended by a gesture or a deliberate
    /// scroll needs no resync; that scroll does it.
    private func finishHold() {
        applyCompensation()
        let resync = Self.shouldResync(
            didRevertSwiftUIOffset: didRevertSwiftUIOffset,
            heldOffsetY: scrollView.flatMap(compensatedOffsetY(in:)),
            minimumOffsetY: scrollView.map { -$0.adjustedContentInset.top }
        ) ? resyncAfterHold : nil
        cancelPreservation()
        resync?()
    }

    /// The resync is a SwiftUI scroll to the transcript's top, so it only
    /// describes the held position when that position is the top. Anchor
    /// re-application has only been seen there (after a status-bar scroll);
    /// anywhere else, leave SwiftUI alone rather than hop.
    nonisolated static func shouldResync(
        didRevertSwiftUIOffset: Bool,
        heldOffsetY: CGFloat?,
        minimumOffsetY: CGFloat?
    ) -> Bool {
        guard didRevertSwiftUIOffset, let heldOffsetY, let minimumOffsetY else { return false }
        return heldOffsetY <= minimumOffsetY + 0.5
    }

    /// Ends a disclosure pin early: the transcript is about to scroll on
    /// purpose (follow, scroll-to-bottom, keyboard). A prepend preservation is
    /// left alone.
    func releaseHold() {
        guard mode == .hold else { return }
        cancelPreservation()
    }

    private func scheduleQuietRelease() {
        quietReleaseTask?.cancel()
        let quietEnd = ContinuousClock.now + .seconds(ChatScrollPolicy.disclosureHoldQuietPeriod)
        let releaseAt = max(quietEnd, prependWindowEnd ?? quietEnd)
        quietReleaseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(until: releaseAt, clock: .continuous)
            guard !Task.isCancelled, let self else { return }
            self.finishHold()
        }
    }

    private func beginPreservation(mode: Mode, scrollView: UIScrollView, window: TimeInterval) {
        self.mode = mode
        completionTask?.cancel()
        quietReleaseTask?.cancel()
        contentSizeObservation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] scrollView, _ in
            Self.handleObservedContentSizeChange(for: self, scrollView: scrollView)
        }
        contentOffsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scrollView, _ in
            Self.handleObservedOffsetChange(for: self, scrollView: scrollView)
        }

        completionTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(window))
            guard !Task.isCancelled, let self else { return }
            if mode == .hold {
                self.finishHold()
            } else {
                self.applyCompensation()
                self.cancelPreservation()
            }
        }
    }

    func cancelPreservation() {
        mode = .prepend
        hasPrependCapture = false
        contentSizeObservation = nil
        contentOffsetObservation = nil
        completionTask?.cancel()
        completionTask = nil
        quietReleaseTask?.cancel()
        quietReleaseTask = nil
        didRevertSwiftUIOffset = false
        resyncAfterHold = nil
        contentSizeChangedThisTurn = false
        lastObservedContentHeight = nil
        baselineContentHeight = nil
        baselineOffsetY = nil
        anchor = nil
        prependWindowEnd = nil
        isApplyingCompensation = false
    }

    nonisolated private static func handleObservedContentSizeChange(
        for controller: ChatScrollPositionController?,
        scrollView: UIScrollView
    ) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak controller, weak scrollView] in
                MainActor.assumeIsolated {
                    guard let scrollView else { return }
                    controller?.handleContentSizeChange(scrollView)
                }
            }
            return
        }

        MainActor.assumeIsolated {
            controller?.handleContentSizeChange(scrollView)
        }
    }

    private func handleContentSizeChange(_ scrollView: UIScrollView) {
        // A callback that outlived a detach must not touch the new attachment.
        guard scrollView === self.scrollView else { return }

        applyCompensation()
        if mode == .hold {
            contentSizeChangedThisTurn = true
            lastObservedContentHeight = scrollView.contentSize.height
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    self?.contentSizeChangedThisTurn = false
                }
            }
            scheduleQuietRelease()
        }
    }

    nonisolated private static func handleObservedOffsetChange(
        for controller: ChatScrollPositionController?,
        scrollView: UIScrollView
    ) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak controller, weak scrollView] in
                MainActor.assumeIsolated {
                    guard let scrollView else { return }
                    controller?.handleOffsetChange(scrollView)
                }
            }
            return
        }

        MainActor.assumeIsolated {
            controller?.handleOffsetChange(scrollView)
        }
    }

    /// User movement releases the preservation. In hold mode an offset change
    /// riding on a size change is SwiftUI re-anchoring and is put back; any
    /// other offset change is a deliberate scroll and releases the hold.
    private func handleOffsetChange(_ scrollView: UIScrollView) {
        guard !isApplyingCompensation, scrollView === self.scrollView else { return }

        if scrollView.isDragging || scrollView.isTracking || scrollView.isDecelerating {
            cancelPreservation()
        } else if mode == .hold {
            let sizeIsChanging = contentSizeChangedThisTurn
                || scrollView.contentSize.height != lastObservedContentHeight
            if sizeIsChanging {
                applyCompensation()
            } else if let targetY = compensatedOffsetY(in: scrollView),
                      abs(scrollView.contentOffset.y - targetY) > 0.5 {
                cancelPreservation()
            }
        }
    }

    private func compensatedOffsetY(in scrollView: UIScrollView) -> CGFloat? {
        guard let baselineOffsetY else { return nil }

        return Self.compensatedOffsetY(
            baselineOffsetY: baselineOffsetY,
            anchorShift: anchorShift(in: scrollView),
            adjustedInset: scrollView.adjustedContentInset,
            contentSizeHeight: scrollView.contentSize.height,
            boundsHeight: scrollView.bounds.height
        )
    }

    /// How far the preserved content moved down since the baseline. The anchor
    /// row's frame says so exactly, whichever side of it the growth happened.
    /// Without one, a prepend falls back to net content growth and a hold
    /// assumes nothing above the reader moved.
    private func anchorShift(in scrollView: UIScrollView) -> CGFloat {
        if let anchor, let minY = rowMinY[anchor.rowID] {
            return minY - anchor.baselineMinY
        }
        guard mode == .prepend, let baselineContentHeight else { return 0 }
        return scrollView.contentSize.height - baselineContentHeight
    }

    private func applyCompensation() {
        guard let scrollView, let targetY = compensatedOffsetY(in: scrollView) else { return }
        guard abs(scrollView.contentOffset.y - targetY) > 0.5 else { return }

        if mode == .hold {
            didRevertSwiftUIOffset = true
        }
        isApplyingCompensation = true
        var offset = scrollView.contentOffset
        offset.y = targetY
        scrollView.setContentOffset(offset, animated: false)
        isApplyingCompensation = false
    }

    nonisolated static func compensatedOffsetY(
        baselineOffsetY: CGFloat,
        anchorShift: CGFloat,
        adjustedInset: UIEdgeInsets,
        contentSizeHeight: CGFloat,
        boundsHeight: CGFloat
    ) -> CGFloat {
        let minimumY = -adjustedInset.top
        let maximumY = max(
            minimumY,
            contentSizeHeight - boundsHeight + adjustedInset.bottom
        )
        return min(max(baselineOffsetY + anchorShift, minimumY), maximumY)
    }
}

/// Pins a subtree to left-to-right regardless of the surrounding chat layout
/// direction, so code, math, data tables, tool-call bodies, file paths, and
/// images never render mirrored inside an RTL message (issue #259). A fixed
/// `layoutDirection` also isolates the subtree's bidi resolution from the parent
/// paragraph direction.
///
/// Forcing LTR also changes how the *parent* resolves this view's
/// `.leading`/`.trailing` alignment guides: an LTR child inside an RTL
/// `VStack(alignment: .leading)` reports its leading edge as its physical left,
/// so the RTL parent — which pins `.leading` to its right edge — would hug or push
/// a narrower-than-container child off the wrong side. When the parent is RTL we
/// remap the guides back to the parent's expectation; in LTR (the default) the
/// guide closures return the unmodified values, so it is a no-op.
private struct ForcedLeftToRightModifier: ViewModifier {
    @Environment(\.layoutDirection) private var parentDirection

    func body(content: Content) -> some View {
        content
            .environment(\.layoutDirection, .leftToRight)
            .alignmentGuide(.leading) { dimensions in
                parentDirection == .rightToLeft ? dimensions[.trailing] : dimensions[.leading]
            }
            .alignmentGuide(.trailing) { dimensions in
                parentDirection == .rightToLeft ? dimensions[.leading] : dimensions[.trailing]
            }
    }
}

extension View {
    func forcedLeftToRight() -> some View {
        modifier(ForcedLeftToRightModifier())
    }
}


@MainActor
final class ChatVerticalScrollAxisGuardView: UIView {
    private weak var guardedScrollView: UIScrollView?
    private var observations: [NSKeyValueObservation] = []

    /// Whether the guarded transcript is laid out right-to-left (#259). Drives
    /// which physical edge the horizontal offset rests against; re-clamps on change.
    var isRightToLeft = false {
        didSet {
            guard oldValue != isRightToLeft else { return }
            clampHorizontalOffset()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        guard superview != nil else {
            detach()
            return
        }

        attachToNearestScrollViewIfNeeded()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attachToNearestScrollViewIfNeeded()
    }

    func attachToNearestScrollViewIfNeeded() {
        guard let scrollView = enclosingScrollView() else { return }

        guard scrollView !== guardedScrollView else {
            clampHorizontalOffset()
            return
        }

        observations.removeAll()
        guardedScrollView = scrollView
        scrollView.alwaysBounceHorizontal = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.isDirectionalLockEnabled = true

        observations = [
            scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                Self.clampObservedHorizontalOffset(for: self)
            },
            scrollView.observe(\.bounds, options: [.new]) { [weak self] _, _ in
                Self.clampObservedHorizontalOffset(for: self)
            },
            // Under RTL the pinned rest offset depends on contentSize.width, so a
            // width change (a wide table/streaming code block loading) must re-clamp
            // immediately instead of waiting for the next offset/bounds change (#259).
            scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                Self.clampObservedHorizontalOffset(for: self)
            }
        ]

        clampHorizontalOffset()
    }

    func detach() {
        observations.removeAll()
        guardedScrollView = nil
    }

    private func enclosingScrollView() -> UIScrollView? {
        sequence(first: superview, next: { $0?.superview })
            .first { $0 is UIScrollView } as? UIScrollView
    }

    private func clampHorizontalOffset() {
        guard let scrollView = guardedScrollView else { return }

        let pinnedX = Self.pinnedHorizontalOffsetX(
            isRightToLeft: isRightToLeft,
            adjustedInset: scrollView.adjustedContentInset,
            contentSize: scrollView.contentSize,
            boundsSize: scrollView.bounds.size
        )
        guard abs(scrollView.contentOffset.x - pinnedX) > 0.5 else { return }

        var offset = scrollView.contentOffset
        offset.x = pinnedX
        scrollView.setContentOffset(offset, animated: false)
    }

    /// The horizontal content offset the transcript should rest at, pinned to the
    /// layout-direction-aware *leading* edge so the vertical-only transcript never
    /// drifts sideways (#130) under either direction (#139/#259).
    ///
    /// LTR leading is the physical left, so it rests at `-left inset` exactly as
    /// before — this branch is byte-for-byte the prior behavior. RTL leading is
    /// the physical right, so it rests at the content's trailing edge
    /// (`contentSize.width + right inset - viewport width`), clamped to never fall
    /// below the LTR minimum. When the transcript has no horizontal overflow and
    /// no horizontal inset — its normal case — both branches resolve to `0`.
    nonisolated static func pinnedHorizontalOffsetX(
        isRightToLeft: Bool,
        adjustedInset: UIEdgeInsets,
        contentSize: CGSize,
        boundsSize: CGSize
    ) -> CGFloat {
        let leftEdge = -adjustedInset.left
        guard isRightToLeft else { return leftEdge }

        let rightEdge = contentSize.width + adjustedInset.right - boundsSize.width
        return max(leftEdge, rightEdge)
    }

    nonisolated private static func clampObservedHorizontalOffset(for guardView: ChatVerticalScrollAxisGuardView?) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak guardView] in
                MainActor.assumeIsolated {
                    guardView?.clampHorizontalOffset()
                }
            }
            return
        }

        MainActor.assumeIsolated {
            guardView?.clampHorizontalOffset()
        }
    }
}






struct ChatTranscriptSkeletonRowConfiguration: Identifiable {
    enum Role {
        case assistant
        case user
    }

    let id: String
    let role: Role
    let lines: [ChatTranscriptSkeletonLine]

    static let loadingRows: [ChatTranscriptSkeletonRowConfiguration] = [
        ChatTranscriptSkeletonRowConfiguration(
            id: "assistant-intro",
            role: .assistant,
            lines: [
                ChatTranscriptSkeletonLine(id: "a1", text: "Reviewing the latest project context and open tasks.", maxWidth: 320),
                ChatTranscriptSkeletonLine(id: "a2", text: "Checking recent sessions before continuing.", maxWidth: 260)
            ]
        ),
        ChatTranscriptSkeletonRowConfiguration(
            id: "user-question",
            role: .user,
            lines: [
                ChatTranscriptSkeletonLine(id: "u1", text: "Summarize the changes from the last run.", maxWidth: 280)
            ]
        ),
        ChatTranscriptSkeletonRowConfiguration(
            id: "assistant-response",
            role: .assistant,
            lines: [
                ChatTranscriptSkeletonLine(id: "a3", text: "The current branch has focused UI polish in progress.", maxWidth: 330),
                ChatTranscriptSkeletonLine(id: "a4", text: "Validation is queued after the loading states are updated.", maxWidth: 300),
                ChatTranscriptSkeletonLine(id: "a5", text: "No server changes are required for this slice.", maxWidth: 240)
            ]
        ),
        ChatTranscriptSkeletonRowConfiguration(
            id: "user-followup",
            role: .user,
            lines: [
                ChatTranscriptSkeletonLine(id: "u2", text: "Keep the existing empty and error states.", maxWidth: 260)
            ]
        ),
        ChatTranscriptSkeletonRowConfiguration(
            id: "assistant-outro",
            role: .assistant,
            lines: [
                ChatTranscriptSkeletonLine(id: "a6", text: "Using static placeholders that match the transcript rhythm.", maxWidth: 340),
                ChatTranscriptSkeletonLine(id: "a7", text: "Rows are noninteractive while data loads.", maxWidth: 245)
            ]
        )
    ]
}

struct ChatTranscriptSkeletonLine: Identifiable {
    let id: String
    let text: String
    let maxWidth: CGFloat
}
