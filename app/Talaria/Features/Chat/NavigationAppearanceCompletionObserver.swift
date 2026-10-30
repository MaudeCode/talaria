import SwiftUI
import UIKit

extension EnvironmentValues {
    /// The retained chat whose stable navigation root has completed its initial appearance.
    @Entry var appearedNavigationRoot: RetainedChat? = nil
}

/// Reports the first completed UIKit appearance transition for a SwiftUI destination.
/// `NavigationStack` does not expose push completion directly, while `viewDidAppear`
/// and the transition coordinator remain synchronized with system animation speed.
/// A root revision also reconciles pushed native pages while keeping the navigation controller mounted.
struct NavigationAppearanceCompletionObserver: UIViewControllerRepresentable {
    let action: @MainActor () -> Void
    var rootReplacementRevision: Int? = nil
    var rootPathIsEmpty = true

    func makeUIViewController(context: Context) -> NavigationAppearanceObserverViewController {
        NavigationAppearanceObserverViewController(action: action)
    }

    func updateUIViewController(
        _ uiViewController: NavigationAppearanceObserverViewController,
        context: Context
    ) {
        uiViewController.action = action
        uiViewController.replaceRootIfNeeded(revision: rootReplacementRevision, pathIsEmpty: rootPathIsEmpty)
    }
}

@MainActor
final class NavigationAppearanceObserverViewController: UIViewController {
    var action: @MainActor () -> Void

    private var isAwaitingTransitionCompletion = false
    private var didReportAppearance = false
    private var rootReplacementRevision: Int?
    private var rootPathIsEmpty = true

    init(action: @escaping @MainActor () -> Void) {
        self.action = action
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func replaceRootIfNeeded(revision: Int?, pathIsEmpty: Bool = true) {
        let previous = rootReplacementRevision
        rootReplacementRevision = revision
        rootPathIsEmpty = pathIsEmpty
        guard let revision, pathIsEmpty, let previous, previous != revision, let navigationController,
              navigationController.viewControllers.count > 1,
              let outgoing = navigationController.topViewController else { return }
        // SwiftUI can keep a pushed controller above a replaced split-view root after its bound path is empty.
        DispatchQueue.main.async { [weak self, weak outgoing] in
            guard let outgoing else { return }
            self?.collapsePath(revision: revision, outgoing: outgoing)
        }
    }

    private func collapsePath(revision: Int, outgoing: UIViewController) {
        guard rootReplacementRevision == revision, rootPathIsEmpty, let navigationController,
              navigationController.viewIfLoaded?.window != nil,
              navigationController.viewControllers.contains(where: { $0 === outgoing }),
              navigationController.viewControllers.count > 1 else { return }
        if let transition = navigationController.transitionCoordinator,
           transition.animate(alongsideTransition: nil, completion: { [weak self, weak outgoing] _ in
               DispatchQueue.main.async {
                   guard let outgoing else { return }
                   self?.collapsePath(revision: revision, outgoing: outgoing)
               }
           }) { return }
        navigationController.popToRootViewController(animated: false)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        guard !didReportAppearance, let coordinator = transitionCoordinator else { return }
        isAwaitingTransitionCompletion = true
        coordinator.animate(alongsideTransition: nil) { [weak self] context in
            guard let self else { return }
            isAwaitingTransitionCompletion = false
            guard !context.isCancelled else { return }
            reportAppearanceIfNeeded()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !isAwaitingTransitionCompletion else { return }
        reportAppearanceIfNeeded()
    }

    private func reportAppearanceIfNeeded() {
        guard !didReportAppearance else { return }
        didReportAppearance = true
        action()
    }
}
