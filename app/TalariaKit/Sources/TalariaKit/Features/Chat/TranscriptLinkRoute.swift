import Foundation
import SwiftUI

/// Where a tapped transcript link opens (TAL-442).
public enum TranscriptLinkRoute: Equatable, Sendable {
    /// A workspace file: the source viewer at its line.
    case workspaceFile(WorkspaceFileLink)
    /// An `http` or `https` page: the in-app Safari sheet.
    case inAppBrowser(URL)
    /// Every other link keeps the system behaviour.
    case system

    public static func route(_ url: URL, workspaceRoot: String?) -> TranscriptLinkRoute {
        if let link = WorkspaceFileLink.parse(url, workspaceRoot: workspaceRoot) {
            return .workspaceFile(link)
        }
        // Safari's view accepts only web pages with a host; mail, phone and app links go to the system.
        if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
           url.host()?.isEmpty == false {
            return .inAppBrowser(url)
        }
        return .system
    }
}

/// Opens transcript links through whichever handler the chat installed last.
///
/// One `OpenURLAction` built once and kept for the router's life: a new action on every chat pass would change
/// `openURL` for every link-reading row, settled ones included (TAL-852). The action reads `handler` when a link is
/// tapped, so the tap still sees the chat's latest state, such as its current workspace.
@MainActor
public final class TranscriptLinkRouter {
    public var handler: (URL) -> OpenURLAction.Result = { _ in .systemAction }

    public private(set) lazy var action = OpenURLAction { [weak self] url in
        self?.handler(url) ?? .systemAction
    }

    public init() {}
}

extension View {
    /// Routes `openURL` below this view through `perform`, keeping one action per placement across passes.
    public func transcriptLinks(perform: @escaping (URL) -> OpenURLAction.Result) -> some View {
        modifier(TranscriptLinksModifier(perform: perform))
    }
}

private struct TranscriptLinksModifier: ViewModifier {
    @State private var router = TranscriptLinkRouter()
    let perform: (URL) -> OpenURLAction.Result

    func body(content: Content) -> some View {
        router.handler = perform
        return content.environment(\.openURL, router.action)
    }
}
