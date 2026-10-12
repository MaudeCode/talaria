import SwiftUI
import TalariaKit
import UIKit

/// Whether the app sidebar is open. The container animates every change the moment it is made,
/// and only the sidebar reads it in SwiftUI, so opening and closing never redraws the screen
/// that owns it (TAL-477).
@Observable
final class AppSidebarPresentation {
    var isPresented = false {
        didSet {
            guard isPresented != oldValue else { return }
            didChange?(isPresented)
        }
    }

    @ObservationIgnored fileprivate var didChange: ((Bool) -> Void)?
}

/// The slide-out sidebar behind the app's screen. Core Animation runs the slide, so it keeps its
/// frames while the main thread builds the section just picked in the sidebar (TAL-477).
struct AppSidebarContainer<Sidebar: View, Content: View>: View {
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let presentation: AppSidebarPresentation
    private let onPresentationChange: (Bool) -> Void
    private let sidebar: (Bool) -> Sidebar
    private let content: Content

    init(
        presentation: AppSidebarPresentation,
        onPresentationChange: @escaping (Bool) -> Void,
        @ViewBuilder sidebar: @escaping (_ isPresented: Bool) -> Sidebar,
        @ViewBuilder content: () -> Content
    ) {
        self.presentation = presentation
        self.onPresentationChange = onPresentationChange
        self.sidebar = sidebar
        self.content = content()
    }

    var body: some View {
        AppSidebarHost(
            presentation: presentation,
            sidebar: AnyView(AppSidebarRoot(presentation: presentation, sidebar: sidebar)),
            content: AnyView(content),
            isRightToLeft: layoutDirection == .rightToLeft,
            reduceMotion: reduceMotion,
            onPresentationChange: onPresentationChange
        )
        .ignoresSafeArea()
    }
}

/// Reads the presentation inside the sidebar's own hosting controller.
private struct AppSidebarRoot<Sidebar: View>: View {
    let presentation: AppSidebarPresentation
    let sidebar: (Bool) -> Sidebar

    var body: some View {
        sidebar(presentation.isPresented)
    }
}

private struct AppSidebarHost: UIViewControllerRepresentable {
    let presentation: AppSidebarPresentation
    let sidebar: AnyView
    let content: AnyView
    let isRightToLeft: Bool
    let reduceMotion: Bool
    let onPresentationChange: (Bool) -> Void

    func makeUIViewController(context: Context) -> AppSidebarController {
        AppSidebarController(presentation: presentation)
    }

    func updateUIViewController(_ controller: AppSidebarController, context: Context) {
        controller.onPresentationChange = onPresentationChange
        controller.isRightToLeft = isRightToLeft
        controller.reduceMotion = reduceMotion
        // Each hosting controller starts its own environment; hand it this one whole, so the
        // screens inside see the model context and everything else set above them.
        controller.setRoots(
            sidebar: AnyView(sidebar.environment(\.self, context.environment)),
            content: AnyView(content.environment(\.self, context.environment))
        )
    }
}

final class AppSidebarController: UIViewController {
    var onPresentationChange: (Bool) -> Void = { _ in }
    var isRightToLeft = false {
        didSet {
            guard isRightToLeft != oldValue else { return }
            edgePan.edges = isRightToLeft ? .right : .left
            edgePanArbiter.isRightToLeft = isRightToLeft
            view.setNeedsLayout()
        }
    }
    var reduceMotion = false

    private let presentation: AppSidebarPresentation
    private let sidebarHost = UIHostingController(rootView: AnyView(EmptyView()))
    private let contentHost = UIHostingController(rootView: AnyView(EmptyView()))
    /// Carries the content's slide and its shadow; the clipped surface sits inside it.
    private let surface = UIView()
    private let clip = UIView()
    private let tint = UIView()
    private let edgePan = UIScreenEdgePanGestureRecognizer()
    private let edgePanArbiter = SidebarEdgePanGesture.Coordinator()
    private let surfacePan = UIPanGestureRecognizer()
    private var dragStartX: CGFloat = 0
    /// Where the visuals were last put, so a layout pass mid-drag keeps the drag's position.
    private var progress: CGFloat = 0

    init(presentation: AppSidebarPresentation) {
        self.presentation = presentation
        super.init(nibName: nil, bundle: nil)
        presentation.didChange = { [weak self] isPresented in
            self?.presentationChanged(isPresented)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func setRoots(sidebar: AnyView, content: AnyView) {
        sidebarHost.rootView = sidebar
        contentHost.rootView = content
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        embed(sidebarHost, in: view)
        sidebarHost.view.backgroundColor = .clear

        surface.layer.shadowColor = UIColor.black.cgColor
        surface.layer.shadowRadius = 24
        view.addSubview(surface)
        clip.clipsToBounds = true
        clip.layer.cornerCurve = .continuous
        surface.addSubview(clip)
        embed(contentHost, in: clip)
        clip.accessibilityIdentifier = "app-main-surface"

        tint.backgroundColor = UIColor { traits in
            (traits.userInterfaceStyle == .dark ? UIColor.white : .black).withAlphaComponent(0.12)
        }
        tint.isAccessibilityElement = false
        tint.accessibilityElementsHidden = true
        tint.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tintTapped)))
        surfacePan.addTarget(self, action: #selector(surfacePanned(_:)))
        tint.addGestureRecognizer(surfacePan)
        clip.addSubview(tint)

        edgePan.edges = .left
        edgePan.delegate = edgePanArbiter
        edgePan.addTarget(self, action: #selector(edgePanned(_:)))
        view.addGestureRecognizer(edgePan)

        reflect(isPresented: presentation.isPresented)
        progress = presentation.isPresented ? 1 : 0
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let insets = view.safeAreaInsets
        let width = revealWidth
        // Frames are laid out untransformed; apply(progress:) moves them afterwards.
        sidebarHost.view.transform = .identity
        surface.transform = .identity
        let leadingInset = isRightToLeft ? insets.right : insets.left
        sidebarHost.view.layer.anchorPoint = CGPoint(x: isRightToLeft ? 1 : 0, y: 0.5)
        sidebarHost.view.frame = CGRect(
            x: isRightToLeft ? bounds.width - leadingInset - width : 0,
            y: 0,
            width: leadingInset + width,
            height: bounds.height
        )
        surface.frame = bounds
        clip.frame = surface.bounds
        contentHost.view.frame = clip.bounds
        tint.frame = clip.bounds
        surface.layer.shadowPath = UIBezierPath(roundedRect: surface.bounds, cornerRadius: 56).cgPath
        apply(progress: progress)
    }

    /// The width the content slides aside, measured inside the safe area as before (TAL-416).
    private var revealWidth: CGFloat {
        let insets = view.safeAreaInsets
        return min(360, (view.bounds.width - insets.left - insets.right) * 0.84)
    }

    private var direction: CGFloat {
        isRightToLeft ? -1 : 1
    }

    private func embed(_ child: UIViewController, in container: UIView) {
        addChild(child)
        container.addSubview(child.view)
        child.didMove(toParent: self)
    }

    /// Every visual that follows the sidebar's position, from closed (0) to open (1).
    private func apply(progress: CGFloat) {
        self.progress = progress
        surface.transform = CGAffineTransform(translationX: revealWidth * progress * direction, y: 0)
        surface.layer.shadowOpacity = Float(0.28 * progress)
        surface.layer.shadowOffset = CGSize(width: -8 * direction * progress, height: 0)
        clip.layer.cornerRadius = 56 * progress
        tint.alpha = progress
        if reduceMotion {
            sidebarHost.view.transform = .identity
            sidebarHost.view.alpha = 1
        } else {
            let scale = 0.96 + 0.04 * progress
            sidebarHost.view.transform = CGAffineTransform(scaleX: scale, y: scale)
            sidebarHost.view.alpha = 0.25 + 0.75 * progress
        }
    }

    private func reflect(isPresented: Bool) {
        tint.isUserInteractionEnabled = isPresented
        contentHost.view.accessibilityElementsHidden = isPresented
        // The closed sidebar sits under the screen; VoiceOver must not reach it there.
        sidebarHost.view.accessibilityElementsHidden = !isPresented
        edgePanArbiter.isSidebarPresented = isPresented
    }

    private func presentationChanged(_ isPresented: Bool) {
        reflect(isPresented: isPresented)
        animate(to: isPresented ? 1 : 0)
        // Hand the slide to the render server now, before this turn's SwiftUI update builds
        // whatever screen the sidebar just picked.
        CATransaction.flush()
        onPresentationChange(isPresented)
    }

    private func animate(to progress: CGFloat) {
        let changes = { self.apply(progress: progress) }
        if reduceMotion {
            UIView.animate(
                withDuration: 0.12,
                delay: 0,
                options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction],
                animations: changes
            )
        } else {
            UIView.animate(
                springDuration: 0.28,
                bounce: 0.15,
                delay: 0,
                options: [.beginFromCurrentState, .allowUserInteraction],
                animations: changes
            )
        }
        // The shadow's opacity and offset are layer-only, so UIView's animation leaves them out.
        for keyPath in ["shadowOpacity", "shadowOffset"] {
            let shadow = CABasicAnimation(keyPath: keyPath)
            shadow.fromValue = surface.layer.presentation()?.value(forKeyPath: keyPath)
            shadow.duration = reduceMotion ? 0.12 : 0.28
            shadow.timingFunction = CAMediaTimingFunction(name: .easeOut)
            surface.layer.add(shadow, forKey: keyPath)
        }
    }

    /// Where a drag of `translation` would leave the sidebar, from 0 (closed) to 1 (open).
    private func dragProgress(_ translation: CGFloat) -> CGFloat {
        AppSidebarGesturePolicy.progress(
            isPresented: presentation.isPresented,
            translationWidth: translation,
            revealWidth: revealWidth,
            isRightToLeft: isRightToLeft
        )
    }

    /// Opens or closes from where a drag let go, and settles back if that changes nothing.
    private func settle(projectedTranslation: CGFloat) {
        let shouldOpen = dragProgress(projectedTranslation) >= 0.5
        if shouldOpen == presentation.isPresented {
            animate(to: shouldOpen ? 1 : 0)
        } else {
            presentation.isPresented = shouldOpen
        }
    }

    /// UIScrollView's normal deceleration, so a flick carries the drawer the rest of the way.
    private func projected(_ recognizer: UIPanGestureRecognizer) -> CGFloat {
        let rate = UIScrollView.DecelerationRate.normal.rawValue
        return recognizer.translation(in: nil).x + recognizer.velocity(in: nil).x / 1_000 * rate / (1 - rate)
    }

    @objc private func edgePanned(_ recognizer: UIScreenEdgePanGestureRecognizer) {
        switch recognizer.state {
        case .changed:
            apply(progress: dragProgress(recognizer.translation(in: nil).x))
        case .ended:
            settle(projectedTranslation: projected(recognizer))
        case .cancelled, .failed:
            settle(projectedTranslation: 0)
        default:
            break
        }
    }

    @objc private func tintTapped() {
        presentation.isPresented = false
    }

    /// The open sidebar follows any horizontal drag over the screen beside it.
    @objc private func surfacePanned(_ recognizer: UIPanGestureRecognizer) {
        let translation = recognizer.translation(in: nil)
        if recognizer.state == .began {
            dragStartX = recognizer.location(in: nil).x - translation.x
        }
        let accepted = AppSidebarGesturePolicy.accepts(
            isPresented: presentation.isPresented,
            canPopVisibleStack: false,
            startX: dragStartX,
            containerWidth: view.bounds.width,
            translation: CGSize(width: translation.x, height: translation.y),
            isRightToLeft: isRightToLeft
        )
        switch recognizer.state {
        case .changed where accepted:
            apply(progress: dragProgress(translation.x))
        case .ended where accepted:
            settle(projectedTranslation: projected(recognizer))
        case .ended, .cancelled, .failed:
            settle(projectedTranslation: 0)
        default:
            break
        }
    }
}

/// The closed sidebar's leading-edge pan, replacing a SwiftUI edge strip that raced the
/// navigation stacks' back gestures. UIKit arbitrates it: it never begins over a sheet or while
/// the visible stack can pop or is mid-transition, and the system pop gestures win any race
/// (TAL-462).
enum SidebarEdgePanGesture {
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
