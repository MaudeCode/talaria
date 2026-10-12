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
        // The screen slides edge to edge, as the sidebar's own hosting controllers lay out
        // inside the window's safe area.
        AppSidebarHost(
            presentation: presentation,
            sidebar: AnyView(AppSidebarRoot(presentation: presentation, sidebar: sidebar)),
            content: AnyView(content),
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
    let onPresentationChange: (Bool) -> Void

    func makeUIViewController(context: Context) -> AppSidebarController {
        AppSidebarController(presentation: presentation)
    }

    func updateUIViewController(_ controller: AppSidebarController, context: Context) {
        let environment = context.environment
        controller.onPresentationChange = onPresentationChange
        controller.isRightToLeft = environment.layoutDirection == .rightToLeft
        controller.reduceMotion = environment.accessibilityReduceMotion
        // Each hosting controller starts its own environment; hand it this one whole, so the
        // screens inside see the model context and everything else set above them.
        controller.setRoots(
            sidebar: AnyView(sidebar.environment(\.self, environment)),
            content: AnyView(content.environment(\.self, environment))
        )
    }
}

final class AppSidebarController: UIViewController {
    private enum Motion {
        static let duration: TimeInterval = 0.28
        static let bounce: CGFloat = 0.15
        static let reducedDuration: TimeInterval = 0.12
        /// Close to the display's own corners: iOS 26 drew the surface concentric with them.
        static var cornerRadius: CGFloat {
            if #available(iOS 26.0, *) { 56 } else { 42 }
        }
    }

    var onPresentationChange: (Bool) -> Void = { _ in }
    var isRightToLeft = false {
        didSet {
            guard isRightToLeft != oldValue, isViewLoaded else { return }
            edgePan.edges = isRightToLeft ? .right : .left
            edgePanArbiter.isRightToLeft = isRightToLeft
            view.setNeedsLayout()
        }
    }
    var reduceMotion = false

    private let presentation: AppSidebarPresentation
    private let sidebarHost = UIHostingController(rootView: AnyView(EmptyView()))
    private let contentHost = UIHostingController(rootView: AnyView(EmptyView()))
    /// Carries the screen's slide and its shadow; the clipped screen sits inside it.
    private let surface = UIView()
    private let clip = UIView()
    private let tint = UIView()
    private let edgePan = UIScreenEdgePanGestureRecognizer()
    private let edgePanArbiter = SidebarEdgePanArbiter()
    private let surfacePan = UIPanGestureRecognizer()
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

        tint.backgroundColor = UIColor { traits in
            (traits.userInterfaceStyle == .dark ? UIColor.white : .black).withAlphaComponent(0.12)
        }
        tint.accessibilityElementsHidden = true
        tint.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tintTapped)))
        surfacePan.addTarget(self, action: #selector(surfacePanned(_:)))
        tint.addGestureRecognizer(surfacePan)
        clip.addSubview(tint)

        edgePan.edges = isRightToLeft ? .right : .left
        edgePanArbiter.isRightToLeft = isRightToLeft
        edgePan.delegate = edgePanArbiter
        edgePan.addTarget(self, action: #selector(edgePanned(_:)))
        view.addGestureRecognizer(edgePan)

        reflect(isPresented: presentation.isPresented)
        progress = presentation.isPresented ? 1 : 0
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let width = revealWidth
        // Frames are laid out untransformed; apply(progress:) moves the surface afterwards.
        surface.transform = .identity
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
        surface.layer.shadowPath = UIBezierPath(
            roundedRect: surface.bounds,
            cornerRadius: Motion.cornerRadius
        ).cgPath
        apply(progress: progress)
    }

    /// The width the screen slides aside, measured inside the safe area (TAL-416).
    private var revealWidth: CGFloat {
        let insets = view.safeAreaInsets
        return min(360, (view.bounds.width - insets.left - insets.right) * 0.84)
    }

    private var leadingInset: CGFloat {
        isRightToLeft ? view.safeAreaInsets.right : view.safeAreaInsets.left
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
        let offset = revealWidth * progress
        surface.transform = CGAffineTransform(translationX: offset * direction, y: 0)
        // UIKit measures safe areas through transforms, so sliding the screen off the leading
        // edge would drop its leading inset and lay it out again. Hand back what the slide took.
        let restored = min(leadingInset, offset)
        let additional = isRightToLeft
            ? UIEdgeInsets(top: 0, left: 0, bottom: 0, right: restored)
            : UIEdgeInsets(top: 0, left: restored, bottom: 0, right: 0)
        if contentHost.additionalSafeAreaInsets != additional {
            contentHost.additionalSafeAreaInsets = additional
        }
        surface.layer.shadowOpacity = Float(0.28 * progress)
        surface.layer.shadowOffset = CGSize(width: -8 * direction * progress, height: 0)
        clip.layer.cornerRadius = Motion.cornerRadius * progress
        tint.alpha = progress
        // A fade only: scaling the sidebar would shrink its safe area the same way.
        sidebarHost.view.alpha = reduceMotion ? 1 : 0.25 + 0.75 * progress
    }

    private func reflect(isPresented: Bool) {
        tint.isUserInteractionEnabled = isPresented
        contentHost.view.accessibilityElementsHidden = isPresented
        // The closed sidebar sits under the screen; VoiceOver must not reach it there.
        sidebarHost.view.accessibilityElementsHidden = !isPresented
        edgePanArbiter.isSidebarPresented = isPresented
    }

    /// Only actions and gestures change the presentation, never a SwiftUI update, so flushing
    /// here commits the slide on its own.
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
        // The shadow's opacity and offset are layer-only, so UIView's animation leaves them out;
        // they get the same curve by hand.
        let shadow: (String) -> CABasicAnimation
        if reduceMotion {
            UIView.animate(
                withDuration: Motion.reducedDuration,
                delay: 0,
                options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction],
                animations: changes
            )
            shadow = { keyPath in
                let animation = CABasicAnimation(keyPath: keyPath)
                animation.duration = Motion.reducedDuration
                animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
                return animation
            }
        } else {
            UIView.animate(
                springDuration: Motion.duration,
                bounce: Motion.bounce,
                delay: 0,
                options: [.beginFromCurrentState, .allowUserInteraction],
                animations: changes
            )
            shadow = { keyPath in
                let animation = CASpringAnimation(perceptualDuration: Motion.duration, bounce: Motion.bounce)
                animation.keyPath = keyPath
                animation.duration = animation.settlingDuration
                return animation
            }
        }
        for keyPath in ["shadowOpacity", "shadowOffset"] {
            let animation = shadow(keyPath)
            animation.fromValue = surface.layer.presentation()?.value(forKeyPath: keyPath)
            surface.layer.add(animation, forKey: keyPath)
        }
    }

    /// A drag that catches the sidebar mid-slide takes it from where it is on screen.
    private func stopSlide() {
        if let presented = surface.layer.presentation() {
            let offset = abs(presented.affineTransform().tx)
            apply(progress: revealWidth > 0 ? min(offset / revealWidth, 1) : 0)
        }
        for layer in [surface.layer, clip.layer, tint.layer, sidebarHost.view.layer] {
            layer.removeAllAnimations()
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
        case .began:
            stopSlide()
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

    /// The open sidebar follows any mostly horizontal drag over the screen beside it.
    @objc private func surfacePanned(_ recognizer: UIPanGestureRecognizer) {
        let translation = recognizer.translation(in: nil)
        let isHorizontal = translation == .zero || abs(translation.x) > abs(translation.y)
        switch recognizer.state {
        case .began:
            stopSlide()
        case .changed where isHorizontal:
            apply(progress: dragProgress(translation.x))
        case .ended where isHorizontal:
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
final class SidebarEdgePanArbiter: NSObject, UIGestureRecognizerDelegate {
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
            canPopVisibleStack: SidebarEdgePanArbiter.visibleStackOwnsEdgeSwipe(in: window),
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
