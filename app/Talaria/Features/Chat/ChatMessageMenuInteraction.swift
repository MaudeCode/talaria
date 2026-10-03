import SwiftUI
import UIKit
import TalariaKit

/// Everything a press needs to know about one message, resolved at press time
/// so a menu can never carry a stale message's actions.
struct ChatMessageMenuContent {
    let messageID: String
    let actions: [ChatMessageAction]
    let linkRegions: [ChatMessageLinkRegion]
    let controlRegions: [CGRect]
}

/// The message rows currently on screen, keyed by their marker view.
///
/// Entries hold their view weakly and rebuild their content on demand, so a
/// recycled or torn-down row can never route a menu: it is either gone from the
/// registry or answers with its current message.
@MainActor
final class ChatMessageMenuRegistry {
    struct Hit {
        /// The press point in the row's coordinate space, which is also the
        /// space the row's link regions are measured in.
        let localPoint: CGPoint
        let content: ChatMessageMenuContent
    }

    private struct Entry {
        weak var view: UIView?
        var content: () -> ChatMessageMenuContent?
    }

    private var entries: [ObjectIdentifier: Entry] = [:]

    func register(_ view: UIView, content: @escaping () -> ChatMessageMenuContent?) {
        entries[ObjectIdentifier(view)] = Entry(view: view, content: content)
    }

    func unregister(_ view: UIView) {
        entries.removeValue(forKey: ObjectIdentifier(view))
    }

    func hit(at point: CGPoint, in coordinateSpace: UIView) -> Hit? {
        entries = entries.filter { $0.value.view?.window != nil }

        for entry in entries.values {
            guard let view = entry.view else { continue }
            let localPoint = view.convert(point, from: coordinateSpace)
            guard view.bounds.contains(localPoint), let content = entry.content() else { continue }
            return Hit(localPoint: localPoint, content: content)
        }

        return nil
    }
}

/// Marks a message row's bounds for the transcript's long-press handler.
struct ChatMessageInteractionMarker: UIViewRepresentable {
    let registry: ChatMessageMenuRegistry?
    let content: () -> ChatMessageMenuContent?

    func makeUIView(context: Context) -> ChatMessageInteractionMarkerView {
        ChatMessageInteractionMarkerView()
    }

    func updateUIView(_ uiView: ChatMessageInteractionMarkerView, context: Context) {
        uiView.registry = registry
        registry?.register(uiView, content: content)
    }

    static func dismantleUIView(_ uiView: ChatMessageInteractionMarkerView, coordinator: ()) {
        uiView.registry?.unregister(uiView)
    }
}

@MainActor
final class ChatMessageInteractionMarkerView: UIView {
    weak var registry: ChatMessageMenuRegistry?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func removeFromSuperview() {
        registry?.unregister(self)
        super.removeFromSuperview()
    }
}

/// Owns the transcript's single long-press handler.
///
/// The menu is presented from a one-point anchor placed under the finger rather
/// than from the message bubble, so a long answer opens its actions at the press
/// point instead of snapshotting and lifting the whole bubble.
struct ChatMessageMenuHost: UIViewRepresentable {
    let registry: ChatMessageMenuRegistry
    /// The transcript's link action, so Open Link takes the same workspace-aware
    /// route as a tap (TAL-169) and falls back to the system for everything else.
    @Environment(\.openURL) private var openURL

    func makeUIView(context: Context) -> ChatMessageMenuHostView {
        let view = ChatMessageMenuHostView(registry: registry)
        view.openLink = { openURL($0) }
        return view
    }

    func updateUIView(_ uiView: ChatMessageMenuHostView, context: Context) {
        uiView.openLink = { openURL($0) }
        uiView.attachToNearestScrollViewIfNeeded()
    }

    static func dismantleUIView(_ uiView: ChatMessageMenuHostView, coordinator: ()) {
        uiView.detach()
    }
}

@MainActor
final class ChatMessageMenuHostView: UIView, UIGestureRecognizerDelegate {
    private let registry: ChatMessageMenuRegistry
    private weak var attachedScrollView: UIScrollView?
    private var longPress: UILongPressGestureRecognizer?
    /// A one-point, invisible button whose menu is the message (or link) menu.
    /// Presenting from it is what keeps the bubble unlifted: the menu's source is
    /// the press point, not the row. It is moved into the transcript's current
    /// scroll view on each press, so a rebuilt transcript cannot leave it behind.
    private let anchor = UIButton(type: .custom)

    var openLink: (URL) -> Void = { UIApplication.shared.open($0) }

    init(registry: ChatMessageMenuRegistry) {
        self.registry = registry
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        anchor.showsMenuAsPrimaryAction = true
        anchor.isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attachToNearestScrollViewIfNeeded()
    }

    func attachToNearestScrollViewIfNeeded() {
        guard let scrollView = enclosingScrollView(), scrollView !== attachedScrollView else { return }

        detach()

        let recognizer = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress))
        // Shorter than the system's own text press, so the message menu keeps the
        // precedence the bubble context menu had over selection.
        recognizer.minimumPressDuration = 0.4
        recognizer.allowableMovement = 12
        recognizer.delegate = self
        scrollView.addGestureRecognizer(recognizer)

        attachedScrollView = scrollView
        longPress = recognizer
    }

    func detach() {
        if let longPress {
            attachedScrollView?.removeGestureRecognizer(longPress)
        }
        anchor.removeFromSuperview()
        longPress = nil
        attachedScrollView = nil
    }

    private func enclosingScrollView() -> UIScrollView? {
        sequence(first: superview, next: { $0?.superview })
            .first { $0 is UIScrollView } as? UIScrollView
    }

    @objc private func handleLongPress(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let scrollView = attachedScrollView else { return }

        let point = recognizer.location(in: scrollView)
        guard let (hit, target) = resolve(point, in: scrollView) else { return }

        let menu: UIMenu
        switch target {
        case .link(let url):
            menu = linkMenu(for: url)
        case .message:
            guard !hit.content.actions.isEmpty else { return }
            menu = messageMenu(for: hit.content.actions)
        case .control:
            return
        }

        if anchor.superview !== scrollView {
            scrollView.addSubview(anchor)
        }
        anchor.frame = CGRect(x: point.x, y: point.y, width: 1, height: 1)
        anchor.menu = menu
        anchor.performPrimaryAction()
    }

    private func resolve(
        _ point: CGPoint,
        in scrollView: UIScrollView
    ) -> (ChatMessageMenuRegistry.Hit, ChatMessageMenuTarget)? {
        guard let hit = registry.hit(at: point, in: scrollView) else { return nil }
        let target = ChatMessageMenuPolicy.target(
            at: hit.localPoint,
            linkRegions: hit.content.linkRegions,
            controlRegions: hit.content.controlRegions
        )
        return (hit, target)
    }

    private func messageMenu(for actions: [ChatMessageAction]) -> UIMenu {
        UIMenu(children: actions.map { action in
            UIAction(
                title: action.title,
                image: UIImage(systemName: action.systemImage),
                attributes: action.isEnabled ? [] : .disabled
            ) { _ in
                MainActor.assumeIsolated { action.handler() }
            }
        })
    }

    /// The system's link actions. A press that lands on a link gets these and
    /// only these — no message action is offered alongside them.
    private func linkMenu(for url: URL) -> UIMenu {
        UIMenu(children: [
            UIAction(
                title: String(localized: "Open Link"),
                image: UIImage(systemName: "safari")
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.openLink(url) }
            },
            UIAction(
                title: String(localized: "Copy Link"),
                image: UIImage(systemName: "doc.on.doc")
            ) { _ in
                MainActor.assumeIsolated { UIPasteboard.general.url = url }
            },
            UIAction(
                title: String(localized: "Share…"),
                image: UIImage(systemName: "square.and.arrow.up")
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.share(url) }
            }
        ])
    }

    private func share(_ url: URL) {
        guard let presenter = anchor.window?.rootViewController?.topmostPresentedViewController else { return }
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = anchor
        controller.popoverPresentationController?.sourceRect = anchor.bounds
        presenter.present(controller, animated: true)
    }

    /// A touch that lands on a control is not the press's to measure, so it
    /// cannot cancel the control's own tap however long it is held (TAL-485).
    nonisolated func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldReceive touch: UITouch
    ) -> Bool {
        MainActor.assumeIsolated {
            guard let scrollView = attachedScrollView,
                  let (_, target) = resolve(touch.location(in: scrollView), in: scrollView)
            else { return true }
            return target != .control
        }
    }

    /// The transcript keeps scrolling and selecting while the press is measured;
    /// the press only takes over once it has recognized.
    nonisolated func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

private extension UIViewController {
    var topmostPresentedViewController: UIViewController {
        presentedViewController?.topmostPresentedViewController ?? self
    }
}

private struct ChatMessageMenuRegistryKey: EnvironmentKey {
    static let defaultValue: ChatMessageMenuRegistry? = nil
}

extension EnvironmentValues {
    /// Set by the transcript that owns the long-press handler; nil for message
    /// bubbles rendered outside it, which keep their plain rendering.
    var chatMessageMenuRegistry: ChatMessageMenuRegistry? {
        get { self[ChatMessageMenuRegistryKey.self] }
        set { self[ChatMessageMenuRegistryKey.self] = newValue }
    }
}
