import SwiftUI
import UIKit
import TalariaKit

/// Reports the transcript's scroll geometry and the gesture events that drive
/// the follow latch (`ChatScrollPolicy.FollowEvent`). Metrics arrive on every
/// offset or size change; follow events arrive only when a drag begins and when
/// the gesture, including any momentum, has settled.
struct ChatScrollObserver: UIViewRepresentable {
    let isStreaming: Bool
    let scrollPositionController: ChatScrollPositionController?
    let onFollowEvent: @MainActor (ChatScrollPolicy.FollowEvent) -> Void
    let onMetrics: @MainActor (ChatScrollMetrics) -> Void

    init(
        isStreaming: Bool,
        scrollPositionController: ChatScrollPositionController? = nil,
        onFollowEvent: @escaping @MainActor (ChatScrollPolicy.FollowEvent) -> Void = { _ in },
        onMetrics: @escaping @MainActor (ChatScrollMetrics) -> Void
    ) {
        self.isStreaming = isStreaming
        self.scrollPositionController = scrollPositionController
        self.onFollowEvent = onFollowEvent
        self.onMetrics = onMetrics
    }

    private var metricContext: MetricContext {
        MetricContext(isStreaming: isStreaming)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            metricContext: metricContext,
            scrollPositionController: scrollPositionController,
            onFollowEvent: onFollowEvent,
            onMetrics: onMetrics
        )
    }

    func makeUIView(context: Context) -> ObserverView {
        ObserverView(coordinator: context.coordinator)
    }

    func updateUIView(_ uiView: ObserverView, context: Context) {
        context.coordinator.onMetrics = onMetrics
        context.coordinator.onFollowEvent = onFollowEvent
        context.coordinator.scrollPositionController = scrollPositionController
        uiView.coordinator = context.coordinator
        context.coordinator.updateMetricContext(metricContext)

        context.coordinator.attachIfNeeded(from: uiView, delivery: .deferred)
    }

    static func dismantleUIView(_ uiView: ObserverView, coordinator: Coordinator) {
        uiView.coordinator = nil
        coordinator.detach()
    }

    struct MetricContext: Equatable {
        let isStreaming: Bool
    }

    @MainActor
    final class ObserverView: UIView {
        weak var coordinator: Coordinator?

        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            coordinator?.attachIfNeeded(from: self, delivery: .deferred)
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            coordinator?.attachIfNeeded(from: self, delivery: .deferred)
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            coordinator?.reportMetrics(delivery: .deferred)
        }
    }

    @MainActor
    final class Coordinator: NSObject {
        enum MetricDelivery {
            case immediate
            case deferred
        }

        var onMetrics: @MainActor (ChatScrollMetrics) -> Void
        var onFollowEvent: @MainActor (ChatScrollPolicy.FollowEvent) -> Void

        private weak var scrollView: UIScrollView?
        private weak var observedPanGesture: UIPanGestureRecognizer?
        private var observations: [NSKeyValueObservation] = []
        private var metricContext: MetricContext
        private var lastMetrics: ChatScrollMetrics?
        private var pendingMetrics: ChatScrollMetrics?
        /// Geometry behind the last report the transcript received. Reports
        /// coalesce per run loop, so the away-from-bottom check compares
        /// delivered states, not every intermediate KVO tick.
        private var deliveredGeometry: ChatScrollPolicy.ScrollGeometry?
        private var pendingGeometry: ChatScrollPolicy.ScrollGeometry?
        private var hasScheduledMetricDelivery = false
        /// True from the first drag movement until the gesture, including any
        /// momentum, comes to rest. Mirrors the "user scroll session" the follow
        /// latch reasons about.
        private var isUserScrollSessionActive = false
        private var settleWorkItem: DispatchWorkItem?
        var scrollPositionController: ChatScrollPositionController? {
            didSet {
                guard oldValue !== scrollPositionController else { return }
                oldValue?.detach()
                if let scrollView {
                    scrollPositionController?.attach(to: scrollView)
                }
            }
        }

        init(
            metricContext: MetricContext,
            scrollPositionController: ChatScrollPositionController?,
            onFollowEvent: @escaping @MainActor (ChatScrollPolicy.FollowEvent) -> Void,
            onMetrics: @escaping @MainActor (ChatScrollMetrics) -> Void
        ) {
            self.metricContext = metricContext
            self.scrollPositionController = scrollPositionController
            self.onFollowEvent = onFollowEvent
            self.onMetrics = onMetrics
        }

        func updateMetricContext(_ newContext: MetricContext) {
            guard metricContext != newContext else { return }

            metricContext = newContext
            lastMetrics = nil
        }

        func attachIfNeeded(from view: UIView, delivery: MetricDelivery) {
            guard let scrollView = enclosingScrollView(for: view) else { return }

            guard scrollView !== self.scrollView else {
                scrollPositionController?.attach(to: scrollView)
                reportMetrics(delivery: delivery)
                return
            }

            observations.removeAll()
            lastMetrics = nil
            deliveredGeometry = nil
            endUserScrollSessionSilently()
            self.scrollView = scrollView
            scrollPositionController?.attach(to: scrollView)

            observedPanGesture?.removeTarget(self, action: nil)
            scrollView.panGestureRecognizer.addTarget(self, action: #selector(handlePanGesture(_:)))
            observedPanGesture = scrollView.panGestureRecognizer

            observations = [
                scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                    Self.reportObservedMetrics(for: self)
                },
                scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                    Self.reportObservedMetrics(for: self)
                }
            ]

            reportMetrics(delivery: delivery)
        }

        func detach() {
            observations.removeAll()
            observedPanGesture?.removeTarget(self, action: nil)
            observedPanGesture = nil
            endUserScrollSessionSilently()
            scrollPositionController?.detach()
            lastMetrics = nil
            deliveredGeometry = nil
            pendingMetrics = nil
            pendingGeometry = nil
            hasScheduledMetricDelivery = false
            scrollView = nil
        }

        // MARK: Follow latch events

        @objc private func handlePanGesture(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                cancelSettle()
                isUserScrollSessionActive = true
                onFollowEvent(.userScrollBegin)
            case .ended, .cancelled, .failed:
                guard isUserScrollSessionActive, let scrollView else { return }
                // Remember where the finger lifted: streaming growth during the
                // momentum-detection window must not turn a release at the live
                // edge into an opt-out from follow.
                let releaseIsAtBottom = isAtBottom(scrollView)
                scheduleSettle(after: ChatScrollPolicy.dragSettleDelay) { [weak self] in
                    guard let self, let scrollView = self.scrollView else { return }
                    // Momentum announced itself; its ticks now own the session.
                    if scrollView.isDecelerating { return }
                    self.finishUserScrollSession(isAtBottom: releaseIsAtBottom)
                }
            default:
                break
            }
        }

        /// Each momentum tick pushes the settle check out; the check that
        /// survives runs once deceleration has stopped moving the content.
        private func trackMomentum(_ scrollView: UIScrollView) {
            guard isUserScrollSessionActive, scrollView.isDecelerating else { return }
            scheduleSettle(after: ChatScrollPolicy.momentumSettleDelay) { [weak self] in
                self?.finishUserScrollSessionIfSettled()
            }
        }

        private func finishUserScrollSessionIfSettled() {
            guard isUserScrollSessionActive, let scrollView else { return }
            // A finger back on the glass either becomes a new drag (pan .began)
            // or lifts without one (pan .failed); both paths re-enter above.
            if scrollView.isDragging || scrollView.isTracking { return }
            if scrollView.isDecelerating {
                scheduleSettle(after: ChatScrollPolicy.momentumSettleDelay) { [weak self] in
                    self?.finishUserScrollSessionIfSettled()
                }
                return
            }
            finishUserScrollSession(isAtBottom: isAtBottom(scrollView))
        }

        private func finishUserScrollSession(isAtBottom: Bool) {
            cancelSettle()
            isUserScrollSessionActive = false
            onFollowEvent(.userScrollEnd(isAtBottom: isAtBottom))
        }

        private func endUserScrollSessionSilently() {
            cancelSettle()
            isUserScrollSessionActive = false
        }

        private func scheduleSettle(after delay: TimeInterval, _ body: @escaping @MainActor () -> Void) {
            cancelSettle()
            let workItem = DispatchWorkItem {
                MainActor.assumeIsolated(body)
            }
            settleWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
        }

        private func cancelSettle() {
            settleWorkItem?.cancel()
            settleWorkItem = nil
        }

        private func isAtBottom(_ scrollView: UIScrollView) -> Bool {
            guard let geometry = geometry(of: scrollView) else { return false }
            return ChatScrollPolicy.isAtBottom(distanceFromBottom: geometry.distanceFromBottom)
        }

        private func geometry(of scrollView: UIScrollView) -> ChatScrollPolicy.ScrollGeometry? {
            let inset = scrollView.adjustedContentInset
            let visibleHeight = scrollView.bounds.height - inset.top - inset.bottom
            guard visibleHeight > 0 else { return nil }

            return ChatScrollPolicy.ScrollGeometry(
                offsetY: scrollView.contentOffset.y + inset.top,
                contentHeight: scrollView.contentSize.height,
                visibleHeight: visibleHeight
            )
        }

        func reportMetrics(delivery: MetricDelivery) {
            guard let scrollView else { return }
            trackMomentum(scrollView)

            guard let geometry = geometry(of: scrollView) else { return }
            let isUserInteracting = scrollView.isDragging || scrollView.isTracking || scrollView.isDecelerating
            // While a disclosure pin holds the offset, a toggled row growing
            // below the reader increases the distance without anyone scrolling.
            let isPinned = scrollPositionController?.isHoldingPosition == true
            let metrics = ChatScrollMetrics(
                distanceFromBottom: geometry.distanceFromBottom,
                isUserInteracting: isUserInteracting,
                movedAwayFromBottom: !isUserInteracting && !isPinned
                    && ChatScrollPolicy.isScrollingAwayFromBottom(previous: deliveredGeometry, current: geometry)
            )
            // The transcript only needs a callback when the derived metrics move,
            // but the away-from-bottom check compares viewports, so the geometry
            // has to advance either way. Leaving it stale across a keyboard resize
            // that stays bottom-pinned would make the next gesture-free scroll
            // look like it happened in a different viewport, and be ignored.
            guard metrics != lastMetrics else {
                deliveredGeometry = geometry
                pendingGeometry = hasScheduledMetricDelivery ? geometry : nil
                return
            }

            lastMetrics = metrics

            switch delivery {
            case .immediate:
                deliveredGeometry = geometry
                onMetrics(metrics)
            case .deferred:
                pendingMetrics = metrics
                pendingGeometry = geometry
                guard !hasScheduledMetricDelivery else { return }

                hasScheduledMetricDelivery = true
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        let metrics = self.pendingMetrics
                        let geometry = self.pendingGeometry
                        self.pendingMetrics = nil
                        self.pendingGeometry = nil
                        self.hasScheduledMetricDelivery = false
                        guard let metrics, self.lastMetrics == metrics else { return }
                        self.deliveredGeometry = geometry
                        self.onMetrics(metrics)
                    }
                }
            }
        }

        nonisolated private static func reportObservedMetrics(for coordinator: Coordinator?) {
            guard Thread.isMainThread else {
                DispatchQueue.main.async { [weak coordinator] in
                    MainActor.assumeIsolated {
                        coordinator?.reportMetrics(delivery: .deferred)
                    }
                }
                return
            }

            MainActor.assumeIsolated {
                coordinator?.reportMetrics(delivery: .deferred)
            }
        }

        private func enclosingScrollView(for view: UIView) -> UIScrollView? {
            var current = view.superview

            while let candidate = current {
                if let scrollView = candidate as? UIScrollView {
                    return scrollView
                }

                current = candidate.superview
            }

            return nil
        }
    }
}
