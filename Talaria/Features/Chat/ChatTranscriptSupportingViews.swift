import SwiftUI
import UIKit

struct ChatScrollMetrics: Equatable {
    let distanceFromBottom: CGFloat
    let isUserInteracting: Bool
}


/// Keeps the reader's exact vertical position while older transcript rows are
/// inserted above it. `ScrollViewProxy.scrollTo(_:anchor:)` can only align a row
/// to a coarse anchor; aligning the previous first row to `.top` loses the gap
/// formerly occupied by the Load Older button and causes a visible hop.
///
/// This controller snapshots the UIKit scroll geometry before the request, then
/// offsets by the net content-height growth during the following layout pass.
/// The correction is deliberately non-animated: it preserves an existing
/// position rather than navigating to a new one.
@MainActor
final class ChatPrependScrollPositionController {
    private weak var scrollView: UIScrollView?
    private var baselineContentHeight: CGFloat?
    private var baselineOffsetY: CGFloat?
    private var contentSizeObservation: NSKeyValueObservation?
    private var contentOffsetObservation: NSKeyValueObservation?
    private var completionTask: Task<Void, Never>?
    private var isApplyingCompensation = false

    func attach(to scrollView: UIScrollView) {
        guard scrollView !== self.scrollView else { return }
        cancelPreservation()
        self.scrollView = scrollView
    }

    func detach() {
        cancelPreservation()
        scrollView = nil
    }

    @discardableResult
    func capture() -> Bool {
        cancelPreservation()
        guard let scrollView else { return false }

        baselineContentHeight = scrollView.contentSize.height
        baselineOffsetY = scrollView.contentOffset.y
        return true
    }

    /// Arms compensation before SwiftUI performs the prepend layout. Returns
    /// false when the user moved the scroll view while the request was in flight,
    /// leaving the caller free to use its coarse fallback instead of overriding
    /// user-owned movement.
    @discardableResult
    func restoreAfterPrepend() -> Bool {
        guard let scrollView,
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

        contentSizeObservation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
            Self.handleObservedContentSizeChange(for: self)
        }
        contentOffsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scrollView, _ in
            Self.handleObservedUserMovement(for: self, scrollView: scrollView)
        }

        // Text and attachment layout can settle over several run-loop passes.
        // Keep applying the same net-height correction for a short bounded
        // window, then release ownership back to normal scrolling.
        completionTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self else { return }
            self.applyCompensation()
            self.cancelPreservation()
        }
        return true
    }

    func cancelPreservation() {
        contentSizeObservation = nil
        contentOffsetObservation = nil
        completionTask?.cancel()
        completionTask = nil
        baselineContentHeight = nil
        baselineOffsetY = nil
        isApplyingCompensation = false
    }

    nonisolated private static func handleObservedContentSizeChange(
        for controller: ChatPrependScrollPositionController?
    ) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak controller] in
                MainActor.assumeIsolated {
                    controller?.applyCompensation()
                }
            }
            return
        }

        MainActor.assumeIsolated {
            controller?.applyCompensation()
        }
    }

    nonisolated private static func handleObservedUserMovement(
        for controller: ChatPrependScrollPositionController?,
        scrollView: UIScrollView
    ) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak controller, weak scrollView] in
                MainActor.assumeIsolated {
                    guard let scrollView else { return }
                    controller?.cancelIfUserIsMoving(scrollView)
                }
            }
            return
        }

        MainActor.assumeIsolated {
            controller?.cancelIfUserIsMoving(scrollView)
        }
    }

    private func cancelIfUserIsMoving(_ scrollView: UIScrollView) {
        guard !isApplyingCompensation,
              scrollView.isDragging || scrollView.isTracking || scrollView.isDecelerating
        else { return }

        cancelPreservation()
    }

    private func applyCompensation() {
        guard let scrollView,
              let baselineContentHeight,
              let baselineOffsetY
        else { return }

        let targetY = Self.compensatedOffsetY(
            baselineOffsetY: baselineOffsetY,
            contentHeightDelta: scrollView.contentSize.height - baselineContentHeight,
            adjustedInset: scrollView.adjustedContentInset,
            contentSizeHeight: scrollView.contentSize.height,
            boundsHeight: scrollView.bounds.height
        )
        guard abs(scrollView.contentOffset.y - targetY) > 0.5 else { return }

        isApplyingCompensation = true
        var offset = scrollView.contentOffset
        offset.y = targetY
        scrollView.setContentOffset(offset, animated: false)
        isApplyingCompensation = false
    }

    nonisolated static func compensatedOffsetY(
        baselineOffsetY: CGFloat,
        contentHeightDelta: CGFloat,
        adjustedInset: UIEdgeInsets,
        contentSizeHeight: CGFloat,
        boundsHeight: CGFloat
    ) -> CGFloat {
        let minimumY = -adjustedInset.top
        let maximumY = max(
            minimumY,
            contentSizeHeight - boundsHeight + adjustedInset.bottom
        )
        return min(max(baselineOffsetY + contentHeightDelta, minimumY), maximumY)
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
