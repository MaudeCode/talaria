import Foundation

/// Where a tapped transcript link opens.
public enum TranscriptLinkRoute: Equatable {
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
        // Safari's view accepts only web pages; mail, phone and app links go to the system.
        if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            return .inAppBrowser(url)
        }
        return .system
    }
}
