import CoreGraphics
import Foundation
import SwiftUI

/// Pure decision rules for the chat transcript's auto-scroll behavior.
///
/// Auto-follow is an explicit latch rather than a distance test.
///
/// Follow switches **off** when a drag begins, when a live gesture moves the
/// offset, or when a scroll with no gesture carries the reader away from the
/// bottom (a status-bar tap, VoiceOver, or a hardware-keyboard scroll).
///
/// Follow switches **on** when a scroll-to-bottom tap or a send resets it, when
/// a gesture settles at the true bottom, or when a non-gesture offset change
/// lands at the true bottom from nearby (a collapse near the end clamping the
/// offset). Landing at the bottom from far above is a relayout artifact, never
/// a reason to follow.
///
/// Layout growth from streaming tokens and keyboard inset changes never flip
/// the latch on their own, so a reader parked above the end stays parked. The
/// distance thresholds below drive the scroll-to-bottom button, the
/// reading-older chrome, and how far a gesture-free scroll must carry the
/// reader before it counts as leaving.
public enum ChatScrollPolicy {
    /// Buffer four viewports while reading history; keep one viewport at the latest edge.
    public static func shouldPrefetchHistory(geometry: ScrollGeometry) -> Bool {
        let screens: CGFloat = isAtBottom(distanceFromBottom: geometry.distanceFromBottom) ? 1 : 4
        return geometry.offsetY <= geometry.visibleHeight * screens
    }

    /// Distance (pt) from the bottom within which the scroll-to-bottom button
    /// stays hidden while idle.
    private static let bottomDetectionThreshold: CGFloat = 80

    /// Looser bottom threshold while a response is streaming, so small layout
    /// jitter from incoming tokens does not flash the scroll-to-bottom button.
    private static let streamingBottomDetectionThreshold: CGFloat = 160

    /// Extra distance past the bottom threshold required before the composer
    /// chrome collapses into its compact "reading older" presentation.
    private static let readingOlderHysteresis: CGFloat = 64

    /// Strict bottom tolerance (pt) that re-arms follow when a gesture ends there.
    private static let followReArmThreshold: CGFloat = 12

    /// How long a finished drag waits for momentum to announce itself before the
    /// release position is treated as final. Finger-lift velocity is not a
    /// reliable signal: a gentle fling can report zero and still decelerate.
    public static let dragSettleDelay: TimeInterval = 0.16

    /// Gap between momentum ticks that means deceleration has stopped.
    public static let momentumSettleDelay: TimeInterval = 0.05

    /// The offset pin armed by a disclosure toggle releases once the content
    /// size has been quiet this long. Lazy rows can keep laying out well past
    /// the animation, and SwiftUI re-applies the bottom anchor on each of those
    /// size changes after a status-bar scroll, so a fixed window is not enough.
    public static let disclosureHoldQuietPeriod: TimeInterval = 0.3

    /// Upper bound on the pin, so a transcript that never goes quiet (streaming
    /// tokens) still returns to normal scrolling.
    public static let disclosureHoldMaximum: TimeInterval = 2

    /// The suspension a disclosure toggle starts, and the one automatic follow
    /// it may owe. Follow triggers are edge-triggered, so one that lands while
    /// the toggle settles is recorded and replayed when the suspension expires,
    /// provided the latch still follows. Without the replay a stream's last
    /// trigger can leave its final content below the viewport while the latch
    /// still reports following.
    public struct DisclosureSettle: Equatable, Sendable {
        public private(set) var isSettling = false
        /// Identifies the current suspension, so an outdated expiry cannot end
        /// a later one.
        private var generation = 0
        private var owesFollow = false

        public init() {}

        /// A disclosure toggled: start, or restart, the suspension. Returns the
        /// generation its expiry must present.
        public mutating func begin() -> Int {
            generation += 1
            isSettling = true
            return generation
        }

        /// An automatic follow was skipped. It is owed only when the latch
        /// wanted it and the suspension alone blocked it.
        public mutating func recordSuppressedFollow(isFollowing: Bool) {
            if isSettling, isFollowing {
                owesFollow = true
            }
        }

        /// The reader opted out of follow, so nothing is owed any more.
        public mutating func cancelOwedFollow() {
            owesFollow = false
        }

        /// An explicit jump ends the suspension at once and performs its own
        /// scroll, so the owed follow is dropped.
        public mutating func end() {
            owesFollow = false
            guard isSettling else { return }
            generation += 1
            isSettling = false
        }

        /// The suspension's timer fired. Returns true when the owed follow
        /// should run now.
        public mutating func expire(generation: Int, isFollowing: Bool) -> Bool {
            guard generation == self.generation, isSettling else { return false }
            isSettling = false
            defer { owesFollow = false }
            return owesFollow && isFollowing
        }
    }

    /// Scroll-gesture events that drive the follow latch.
    public enum FollowEvent: Equatable, Sendable {
        /// An explicit jump to the latest content: scroll-to-bottom tap or send.
        case reset
        /// The user started dragging the transcript.
        case userScrollBegin
        /// The user's gesture settled: a drag with no momentum after
        /// `dragSettleDelay`, or deceleration coming to rest. Re-arms at the
        /// bottom; elsewhere it keeps whatever the latch already is, so a
        /// send or scroll-to-bottom tap that landed while the gesture was
        /// still settling is not undone by the late settle report.
        case userScrollEnd(isAtBottom: Bool)
        /// The content offset changed for any other reason: streaming growth,
        /// keyboard presentation, a programmatic scroll, or a live gesture.
        /// `movedAwayFromBottom` marks a scroll with no gesture that carried
        /// the reader away from the bottom (see `ScrollAwayTracker`);
        /// `wasNearBottom` is where the previous report left the reader.
        case contentScrolled(
            isAtBottom: Bool,
            isUserScrolling: Bool,
            movedAwayFromBottom: Bool = false,
            wasNearBottom: Bool = true
        )
    }

    /// The scroll geometry one metrics report is derived from.
    public struct ScrollGeometry: Equatable, Sendable {
        var offsetY: CGFloat
        var contentHeight: CGFloat
        var visibleHeight: CGFloat

        public init(offsetY: CGFloat, contentHeight: CGFloat, visibleHeight: CGFloat) {
            self.offsetY = offsetY
            self.contentHeight = contentHeight
            self.visibleHeight = visibleHeight
        }

        public var distanceFromBottom: CGFloat {
            max(0, contentHeight - visibleHeight - offsetY)
        }
    }

    /// True when a report without a gesture shows the reader farther from the
    /// bottom than the last one, past the streaming threshold, in the same
    /// viewport. The offset must actually move upward: lazy measurement can
    /// increase the distance while the reader is stationary or following down.
    /// Actual status-bar, VoiceOver and keyboard scrolls may also remeasure rows.
    /// Keyboard viewport changes and disclosure pins are excluded, and
    /// `ScrollAwayTracker` waits for a second report before it counts.
    public static func isScrollingAwayFromBottom(previous: ScrollGeometry?, current: ScrollGeometry) -> Bool {
        guard let previous, previous.visibleHeight == current.visibleHeight,
              current.offsetY < previous.offsetY - 0.5 else { return false }
        let distance = current.distanceFromBottom
        return distance > previous.distanceFromBottom + 0.5
            && distance > streamingBottomDetectionThreshold
    }

    /// Judges each gesture-free report against the last report the transcript
    /// received. Reports coalesce per run loop, so this compares delivered
    /// states, not every intermediate KVO tick.
    ///
    /// A move away counts only when the report after it keeps moving away. A
    /// row above the viewport that re-measures, as a long transcript's lazy
    /// rows do under a keyboard show or hide, moves the offset up in one report
    /// and shrinks the content height by the same amount in a later one
    /// (TAL-2548). The first report looks exactly like a scroll away; the next
    /// restores the distance. Status-bar, VoiceOver and hardware-keyboard
    /// scrolls animate over several frames, so they still release follow, one
    /// frame later.
    public struct ScrollAwayTracker: Sendable {
        private var delivered: ScrollGeometry?
        /// The delivered report was itself a move away, not yet confirmed.
        private var deliveredMovedAway = false

        public init() {}

        /// True when `current` confirms a move away from the bottom.
        public func movesAway(to current: ScrollGeometry) -> Bool {
            deliveredMovedAway && isScrollingAwayFromBottom(previous: delivered, current: current)
        }

        /// An offset changed within the same viewport and content layout, in either direction.
        public func changedOffsetInSameLayout(to current: ScrollGeometry) -> Bool {
            guard let delivered, delivered.visibleHeight == current.visibleHeight,
                  delivered.contentHeight == current.contentHeight else { return false }
            return abs(delivered.offsetY - current.offsetY) > 0.5
        }

        /// Records the geometry behind a report the transcript received.
        public mutating func deliver(_ geometry: ScrollGeometry) {
            guard geometry != delivered else { return }
            deliveredMovedAway = isScrollingAwayFromBottom(previous: delivered, current: geometry)
            delivered = geometry
        }
    }

    /// The follow latch. `isFollowing` is the answer; the second flag lets an
    /// explicit reset outlive a gesture that was still coasting when it landed.
    public struct FollowLatch: Equatable, Sendable {
        public var isFollowing = true
        /// Set by `.reset`. Until the gesture settles or a new drag begins, live
        /// offset changes still flagged as user scrolling belong to momentum
        /// that predates the explicit action and must not switch follow off.
        var ignoresCoastingGesture = false

        public init(isFollowing: Bool = true, ignoresCoastingGesture: Bool = false) {
            self.isFollowing = isFollowing
            self.ignoresCoastingGesture = ignoresCoastingGesture
        }
    }

    /// Reduces one event onto the current latch state.
    public static func resolveFollow(current: FollowLatch, event: FollowEvent) -> FollowLatch {
        var latch = current
        switch event {
        case .reset:
            latch.isFollowing = true
            latch.ignoresCoastingGesture = true
        case .userScrollBegin:
            latch.isFollowing = false
            latch.ignoresCoastingGesture = false
        case .userScrollEnd(let isAtBottom):
            latch.isFollowing = isAtBottom || current.isFollowing
            latch.ignoresCoastingGesture = false
        case .contentScrolled(let isAtBottom, let isUserScrolling, let movedAwayFromBottom, let wasNearBottom):
            if isUserScrolling {
                if !current.ignoresCoastingGesture {
                    latch.isFollowing = false
                }
            } else if movedAwayFromBottom {
                latch.isFollowing = false
            } else if isAtBottom, wasNearBottom {
                latch.isFollowing = true
            }
        }
        return latch
    }

    public static func isAtBottom(distanceFromBottom: CGFloat) -> Bool {
        distanceFromBottom <= followReArmThreshold
    }

    private static func bottomThreshold(isStreaming: Bool) -> CGFloat {
        isStreaming ? streamingBottomDetectionThreshold : bottomDetectionThreshold
    }

    public static func isNearBottom(distanceFromBottom: CGFloat, isStreaming: Bool) -> Bool {
        distanceFromBottom <= bottomThreshold(isStreaming: isStreaming)
    }

    /// True once the user has scrolled far enough above the bottom that the
    /// composer chrome should collapse. The hysteresis keeps the chrome stable
    /// when hovering right around the bottom threshold.
    public static func shouldEnterReadingOlder(distanceFromBottom: CGFloat, isStreaming: Bool) -> Bool {
        distanceFromBottom > bottomThreshold(isStreaming: isStreaming) + readingOlderHysteresis
    }

    public static func shouldUseCompactComposer(
        isReadingOlderTranscript: Bool,
        hasMessages: Bool,
        isFocused: Bool,
        hasDraft: Bool,
        hasPendingAttachments: Bool,
        isLoadingComposerConfiguration: Bool,
        isBusyOrUnavailable: Bool,
        requiresExpandedPresentation: Bool
    ) -> Bool {
        // Configuration metadata loads independently; available controls can stay
        // disabled without holding the whole composer open.
        isReadingOlderTranscript
            && hasMessages
            && !isFocused
            && !hasDraft
            && !hasPendingAttachments
            && !isBusyOrUnavailable
            && !requiresExpandedPresentation
    }
}

/// Transcript disclosure controls (reasoning blocks, tool cards, marker cards,
/// completed-work headers) call this right before they toggle so the transcript
/// can pin the reader's offset and suspend follow scrolls through the size
/// change.
public typealias ChatDisclosureToggleAction = ChatEnvironmentAction<Void, Void>

struct ChatDisclosureToggledKey: EnvironmentKey {
    static var defaultValue: ChatDisclosureToggleAction { ChatDisclosureToggleAction { _ in } }
}

extension EnvironmentValues {
    public var chatDisclosureToggled: ChatDisclosureToggleAction {
        get { self[ChatDisclosureToggledKey.self] }
        set { self[ChatDisclosureToggledKey.self] = newValue }
    }
}

extension View {
    /// Publishes `perform` as the disclosure action below this view.
    public func chatDisclosureToggled(perform: @escaping () -> Void) -> some View {
        chatEnvironmentAction(\.chatDisclosureToggled) { _ in perform() }
    }
}
