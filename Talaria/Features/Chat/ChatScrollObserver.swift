import SwiftUI
import UIKit

struct ChatScrollObserver: UIViewRepresentable {
    let isStreaming: Bool
    let prependScrollPositionController: ChatPrependScrollPositionController?
    let onMetrics: @MainActor (ChatScrollMetrics) -> Void

    init(
        isStreaming: Bool,
        prependScrollPositionController: ChatPrependScrollPositionController? = nil,
        onMetrics: @escaping @MainActor (ChatScrollMetrics) -> Void
    ) {
        self.isStreaming = isStreaming
        self.prependScrollPositionController = prependScrollPositionController
        self.onMetrics = onMetrics
    }

    private var metricContext: MetricContext {
        MetricContext(isStreaming: isStreaming)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            metricContext: metricContext,
            prependScrollPositionController: prependScrollPositionController,
            onMetrics: onMetrics
        )
    }

    func makeUIView(context: Context) -> ObserverView {
        ObserverView(coordinator: context.coordinator)
    }

    func updateUIView(_ uiView: ObserverView, context: Context) {
        context.coordinator.onMetrics = onMetrics
        context.coordinator.prependScrollPositionController = prependScrollPositionController
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

        private weak var scrollView: UIScrollView?
        private var observations: [NSKeyValueObservation] = []
        private var metricContext: MetricContext
        private var lastMetrics: ChatScrollMetrics?
        private var pendingMetrics: ChatScrollMetrics?
        private var hasScheduledMetricDelivery = false
        var prependScrollPositionController: ChatPrependScrollPositionController? {
            didSet {
                guard oldValue !== prependScrollPositionController else { return }
                oldValue?.detach()
                if let scrollView {
                    prependScrollPositionController?.attach(to: scrollView)
                }
            }
        }

        init(
            metricContext: MetricContext,
            prependScrollPositionController: ChatPrependScrollPositionController?,
            onMetrics: @escaping @MainActor (ChatScrollMetrics) -> Void
        ) {
            self.metricContext = metricContext
            self.prependScrollPositionController = prependScrollPositionController
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
                prependScrollPositionController?.attach(to: scrollView)
                reportMetrics(delivery: delivery)
                return
            }

            observations.removeAll()
            lastMetrics = nil
            self.scrollView = scrollView
            prependScrollPositionController?.attach(to: scrollView)

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
            prependScrollPositionController?.detach()
            lastMetrics = nil
            pendingMetrics = nil
            hasScheduledMetricDelivery = false
            scrollView = nil
        }

        func reportMetrics(delivery: MetricDelivery) {
            guard let scrollView else { return }

            let inset = scrollView.adjustedContentInset
            let visibleHeight = scrollView.bounds.height - inset.top - inset.bottom
            guard visibleHeight > 0 else { return }

            let currentOffset = scrollView.contentOffset.y + inset.top
            let maximumOffset = scrollView.contentSize.height - visibleHeight
            let distanceFromBottom = max(0, maximumOffset - currentOffset)
            let metrics = ChatScrollMetrics(
                distanceFromBottom: distanceFromBottom,
                isUserInteracting: scrollView.isDragging || scrollView.isTracking || scrollView.isDecelerating
            )
            guard metrics != lastMetrics else { return }

            lastMetrics = metrics

            switch delivery {
            case .immediate:
                onMetrics(metrics)
            case .deferred:
                pendingMetrics = metrics
                guard !hasScheduledMetricDelivery else { return }

                hasScheduledMetricDelivery = true
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        let metrics = self.pendingMetrics
                        self.pendingMetrics = nil
                        self.hasScheduledMetricDelivery = false
                        guard let metrics, self.lastMetrics == metrics else { return }
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
