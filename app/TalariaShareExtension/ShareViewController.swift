import UIKit
import TalariaKit
#if DEBUG
import notify
#endif

@MainActor
final class ShareViewController: UIViewController {
    private let statusLabel = UILabel()
    private var didStartOpening = false

    override func viewDidLoad() {
        super.viewDidLoad()
        configureView()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        guard !didStartOpening else { return }
        didStartOpening = true

        Task {
            await saveDraftAndOpenTalaria()
        }
    }

    private func configureView() {
        view.backgroundColor = .clear
        view.isOpaque = false

        statusLabel.text = "Opening Talaria..."
        statusLabel.font = .preferredFont(forTextStyle: .headline)
        statusLabel.textAlignment = .center
        statusLabel.textColor = .secondaryLabel
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0
        statusLabel.isHidden = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    private func saveDraftAndOpenTalaria() async {
        do {
            let input = try await ShareInputReader.input(from: extensionContext)
            let draft = TalariaShareDraft.draftText(textSnippets: input.textSnippets, urls: input.urls)

            guard !draft.isEmpty || !input.attachments.isEmpty else {
                showStatus("Talaria accepts text, URLs, images, PDFs, and files up to 20 MB.")
                completeRequest(after: statusDwell)
                return
            }

            guard let directory = TalariaShareDraft.containerURL() else {
                showStatus("Could not access Talaria storage.")
                completeRequest(after: statusDwell)
                return
            }

            try TalariaShareDraft.savePendingImport(draft: draft, attachments: input.attachments, in: directory)
        } catch let error as SharedDraftStoreError {
            showStatus(error.localizedDescription)
            completeRequest(after: statusDwell)
            return
        } catch {
            showStatus("Could not save shared content.")
            completeRequest(after: statusDwell)
            return
        }

        openTalaria()
    }

    private func showStatus(_ text: String) {
        statusLabel.text = text
        statusLabel.isHidden = false
        // The sheet dismisses itself shortly after, so VoiceOver has to be moved to the
        // message rather than wait for the user to find it (TAL-81).
        UIAccessibility.post(notification: .layoutChanged, argument: statusLabel)
    }

    private func openTalaria() {
        let url = TalariaShareDraft.openURL

        #if DEBUG
        // TAL-81: no host can make `open` fail on demand, so the UI tests select the
        // launch path they are validating through the shared app group.
        if ShareOpenFixtureMode.current != .normal {
            openTalariaViaWorkaround(url)
            return
        }
        #endif

        extensionContext?.open(url, completionHandler: { [weak self] success in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if success {
                    self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
                } else {
                    self.openTalariaViaWorkaround(url)
                }
            }
        })
    }

    private func openTalariaViaWorkaround(_ url: URL) {
        #if DEBUG
        if ShareOpenFixtureMode.current == .manualOnly {
            showManualOpenFallback()
            return
        }
        #endif

        let application = containingApplicationResponder()
        if let application, open(url, using: application) {
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            return
        }

        if openViaResponderChain(url) || openViaContainingApplication(url) {
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            return
        }

        showManualOpenFallback()
    }

    /// Last resort: the draft is already stored, so tell the user how to reach it.
    private func showManualOpenFallback() {
        showStatus("Shared content saved. Open Talaria manually.")
        completeRequest(after: statusDwell)
    }

    private func openViaContainingApplication(_ url: URL) -> Bool {
        // Owner-accepted App Review risk: share extensions have no guaranteed
        // containing-app launcher, but this preserves the current fast return UX.
        let sharedApplicationSelector = NSSelectorFromString("sharedApplication")
        let openURLModernSelector = NSSelectorFromString("openURL:options:completionHandler:")

        guard
            let applicationClass = NSClassFromString("UIApplication") as? NSObject.Type,
            applicationClass.responds(to: sharedApplicationSelector),
            let application = applicationClass.perform(sharedApplicationSelector)?.takeUnretainedValue() as? NSObject
        else {
            return false
        }

        if application.responds(to: openURLModernSelector),
           let implementation = application.method(for: openURLModernSelector) {
            typealias OpenURLModernFunction = @convention(c) (NSObject, Selector, NSURL, NSDictionary, Any?) -> Void
            let openURL = unsafeBitCast(implementation, to: OpenURLModernFunction.self)
            openURL(application, openURLModernSelector, url as NSURL, [:] as NSDictionary, nil)
            return true
        }

        return false
    }

    private func containingApplicationResponder() -> UIResponder? {
        guard let applicationClass = NSClassFromString("UIApplication") else {
            return nil
        }

        var responder: UIResponder? = self
        while let currentResponder = responder {
            if currentResponder.isKind(of: applicationClass) {
                return currentResponder
            }

            responder = currentResponder.next
        }

        return nil
    }

    private func openViaResponderChain(_ url: URL) -> Bool {
        var responder: UIResponder? = self

        while let currentResponder = responder {
            if open(url, using: currentResponder) {
                return true
            }

            responder = currentResponder.next
        }

        return false
    }

    private func open(_ url: URL, using responder: UIResponder) -> Bool {
        // Owner-accepted App Review risk; this is a fallback for hosts where
        // NSExtensionContext.open does not route to the containing app.
        if let application = responder as? UIApplication {
            application.open(url, options: [:], completionHandler: nil)
            return true
        }

        let openURLModernSelector = NSSelectorFromString("openURL:options:completionHandler:")
        if responder.responds(to: openURLModernSelector),
           let implementation = responder.method(for: openURLModernSelector) {
            typealias OpenURLModernFunction = @convention(c) (UIResponder, Selector, NSURL, NSDictionary, Any?) -> Void
            let openURL = unsafeBitCast(implementation, to: OpenURLModernFunction.self)
            openURL(responder, openURLModernSelector, url as NSURL, [:] as NSDictionary, nil)
            return true
        }

        return false
    }

    /// Long enough to read the status message, and for VoiceOver to speak it, before the
    /// sheet closes itself.
    private let statusDwell: TimeInterval = 2.5

    #if DEBUG
    private var statusReleaseToken: Int32 = NOTIFY_TOKEN_INVALID

    /// Closes the sheet when the UI test posts `ShareOpenFixtureMode.releaseStatusNotification`,
    /// or after a minute if it never does.
    private func completeRequestWhenTestReleasesStatus() {
        notify_register_dispatch(ShareOpenFixtureMode.releaseStatusNotification, &statusReleaseToken, .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.finishHeldStatus() }
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            self?.finishHeldStatus()
        }
    }

    private func finishHeldStatus() {
        guard statusReleaseToken != NOTIFY_TOKEN_INVALID else { return }
        notify_cancel(statusReleaseToken)
        statusReleaseToken = NOTIFY_TOKEN_INVALID
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
    #endif

    private func completeRequest(after delay: TimeInterval) {
        #if DEBUG
        // TAL-402: under the UI-test share host the status stays until the test has read it.
        if ShareOpenFixtureMode.holdsStatus {
            completeRequestWhenTestReleasesStatus()
            return
        }
        #endif
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }
}
