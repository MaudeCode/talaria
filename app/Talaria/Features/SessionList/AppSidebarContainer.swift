import SwiftUI
import TalariaKit

struct AppSidebarContainer<Sidebar: View, Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding private var isPresented: Bool
    @State private var dragTranslation: CGFloat = 0

    private let sidebar: Sidebar
    private let content: Content

    init(
        isPresented: Binding<Bool>,
        @ViewBuilder sidebar: () -> Sidebar,
        @ViewBuilder content: () -> Content
    ) {
        _isPresented = isPresented
        self.sidebar = sidebar()
        self.content = content()
    }

    var body: some View {
        GeometryReader { proxy in
            let revealWidth = min(360, proxy.size.width * 0.84)
            let progress = progress(revealWidth: revealWidth)
            let horizontalDirection: CGFloat = layoutDirection == .rightToLeft ? -1 : 1
            let surfaceTint = colorScheme == .dark ? Color.white : Color.black
            let surfaceWidth = proxy.size.width
                + proxy.safeAreaInsets.leading
                + proxy.safeAreaInsets.trailing
            let surfaceHeight = proxy.size.height
                + proxy.safeAreaInsets.top
                + proxy.safeAreaInsets.bottom

            ZStack(alignment: .topLeading) {
                Color(.systemBackground)
                    .ignoresSafeArea()

                sidebar
                    .frame(width: revealWidth, height: proxy.size.height)
                    .scaleEffect(reduceMotion ? 1 : 0.96 + 0.04 * progress, anchor: .leading)
                    .opacity(reduceMotion ? 1 : 0.25 + 0.75 * progress)

                content
                    .frame(width: surfaceWidth, height: surfaceHeight)
                    .overlay {
                        if isPresented {
                            surfaceTint.opacity(0.12 * progress)
                                .contentShape(Rectangle())
                                .highPriorityGesture(
                                    dragGesture(
                                        containerWidth: proxy.size.width,
                                        revealWidth: revealWidth
                                    )
                                )
                                .onTapGesture { isPresented = false }
                                .accessibilityHidden(true)
                        } else {
                            surfaceTint.opacity(0.12 * progress)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .clipShape(surfaceShape(progress: progress))
                    .shadow(
                        color: .black.opacity(0.28 * progress),
                        radius: 24 * progress,
                        x: -8 * horizontalDirection * progress
                    )
                    // Unlike the shadow, SwiftUI mirrors the offset under RTL, which slides the
                    // surface toward the trailing edge there too.
                    .offset(
                        x: revealWidth * progress - proxy.safeAreaInsets.leading,
                        y: -proxy.safeAreaInsets.top
                    )
                    .accessibilityHidden(isPresented)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("app-main-surface")
            }
            .gesture(
                SidebarEdgePanGesture(
                    isSidebarPresented: isPresented,
                    isRightToLeft: layoutDirection == .rightToLeft,
                    onChanged: { dragTranslation = $0 },
                    onEnded: { projectedTranslation in
                        dragTranslation = 0
                        isPresented = AppSidebarGesturePolicy.progress(
                            isPresented: false,
                            translationWidth: projectedTranslation,
                            revealWidth: revealWidth,
                            isRightToLeft: layoutDirection == .rightToLeft
                        ) >= 0.5
                    }
                )
            )
        }
        .animation(
            reduceMotion ? .easeOut(duration: 0.12) : .snappy(duration: 0.28),
            value: isPresented
        )
    }

    private func progress(revealWidth: CGFloat) -> CGFloat {
        AppSidebarGesturePolicy.progress(
            isPresented: isPresented,
            translationWidth: dragTranslation,
            revealWidth: revealWidth,
            isRightToLeft: layoutDirection == .rightToLeft
        )
    }

    private func surfaceShape(progress: CGFloat) -> AnyShape {
        if #available(iOS 26.0, *) {
            AnyShape(
                ConcentricRectangle(
                    corners: .concentric(minimum: .fixed(56 * progress))
                )
            )
        } else {
            AnyShape(RoundedRectangle(cornerRadius: 42 * progress, style: .continuous))
        }
    }

    private func dragGesture(
        containerWidth: CGFloat,
        revealWidth: CGFloat
    ) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { value in
                guard AppSidebarGesturePolicy.accepts(
                    isPresented: isPresented,
                    canPopVisibleStack: false,
                    startX: value.startLocation.x,
                    containerWidth: containerWidth,
                    translation: value.translation,
                    isRightToLeft: layoutDirection == .rightToLeft
                ) else { return }

                dragTranslation = value.translation.width
            }
            .onEnded { value in
                defer { dragTranslation = 0 }

                guard AppSidebarGesturePolicy.accepts(
                    isPresented: isPresented,
                    canPopVisibleStack: false,
                    startX: value.startLocation.x,
                    containerWidth: containerWidth,
                    translation: value.translation,
                    isRightToLeft: layoutDirection == .rightToLeft
                ) else { return }

                isPresented = AppSidebarGesturePolicy.progress(
                    isPresented: isPresented,
                    translationWidth: value.predictedEndTranslation.width,
                    revealWidth: revealWidth,
                    isRightToLeft: layoutDirection == .rightToLeft
                ) >= 0.5
            }
    }
}

/// The closed sidebar's leading-edge pan, replacing a SwiftUI edge strip that raced the
/// navigation stacks' back gestures. UIKit arbitrates it: it never begins over a sheet or while
/// the visible stack can pop or is mid-transition, and the system pop gestures win any race
/// (TAL-462).
struct SidebarEdgePanGesture: UIGestureRecognizerRepresentable {
    let isSidebarPresented: Bool
    let isRightToLeft: Bool
    let onChanged: (CGFloat) -> Void
    /// The projected end translation; zero when the pan is cancelled.
    let onEnded: (CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        recognizer.edges = isRightToLeft ? .right : .left
        context.coordinator.isSidebarPresented = isSidebarPresented
        context.coordinator.isRightToLeft = isRightToLeft
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        let translation = recognizer.translation(in: nil).x
        switch recognizer.state {
        case .changed:
            onChanged(translation)
        case .ended:
            // UIScrollView's normal deceleration, so a flick carries the drawer the rest of the way.
            let rate = UIScrollView.DecelerationRate.normal.rawValue
            onEnded(translation + recognizer.velocity(in: nil).x / 1_000 * rate / (1 - rate))
        case .cancelled, .failed:
            onEnded(0)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var isSidebarPresented = false
        var isRightToLeft = false

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            // The open sidebar's own drag closes it.
            guard !isSidebarPresented,
                  let pan = gestureRecognizer as? UIPanGestureRecognizer,
                  let window = pan.view?.window
            else { return false }
            let translation = pan.translation(in: nil)
            return AppSidebarGesturePolicy.accepts(
                isPresented: false,
                canPopVisibleStack: SidebarEdgePanGesture.visibleStackOwnsEdgeSwipe(in: window),
                startX: pan.location(in: nil).x - translation.x,
                containerWidth: window.bounds.width,
                translation: CGSize(width: translation.x, height: translation.y),
                isRightToLeft: isRightToLeft
            )
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            Self.isNavigationPop(otherGestureRecognizer)
        }

        /// A list row's swipe actions start from the same edge, and whichever pan began first used to
        /// win (TAL-490). Content pans wait for this one, which fails at once for a touch away from the
        /// edge; scrolling and the stacks' back gestures keep their own arbitration.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            guard otherGestureRecognizer is UIPanGestureRecognizer,
                  !Self.isNavigationPop(otherGestureRecognizer)
            else { return false }
            if let scrollView = otherGestureRecognizer.view as? UIScrollView,
               otherGestureRecognizer === scrollView.panGestureRecognizer {
                return false
            }
            return true
        }

        private static func isNavigationPop(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let view = recognizer.view else { return false }
            return sequence(first: view as UIResponder, next: \.next).contains { responder in
                guard let navigation = responder as? UINavigationController else { return false }
                if #available(iOS 26.0, *), recognizer === navigation.interactiveContentPopGestureRecognizer {
                    return true
                }
                return recognizer === navigation.interactivePopGestureRecognizer
            }
        }
    }

    /// Whether a sheet covers the app, or an on-screen navigation stack (the chat list's, a
    /// utility's or a split view's detail) shows a pushed screen or is moving between screens.
    static func visibleStackOwnsEdgeSwipe(in window: UIWindow) -> Bool {
        guard let root = window.rootViewController else { return false }
        return root.presentedViewController != nil || canPop(root)
    }

    private static func canPop(_ controller: UIViewController) -> Bool {
        if let navigation = controller as? UINavigationController,
           navigation.viewIfLoaded?.window != nil,
           navigation.viewControllers.count > 1 || navigation.transitionCoordinator != nil {
            return true
        }
        return controller.children.contains { canPop($0) }
    }
}
