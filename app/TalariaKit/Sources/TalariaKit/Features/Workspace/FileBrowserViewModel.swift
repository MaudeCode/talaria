import Foundation

@Observable
public final class FileBrowserViewModel {
    private let session: SessionSummary
    private let apiClient: APIClient

    public private(set) var entries: [WorkspaceEntry] = []
    public private(set) var currentPath = "."
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var lastError: Error?
    private var hasLoadedInitialPath = false
    private var lastRequestedPath = "."
    private var loadRevision = 0

    public var isAtRoot: Bool {
        currentPath == "."
    }

    public var displayPath: String {
        isAtRoot ? String(localized: "Root") : currentPath
    }

    public var parentPath: String? {
        guard !isAtRoot else { return nil }

        let parts = currentPath.split(separator: "/").map(String.init)
        guard parts.count > 1 else { return "." }

        return parts.dropLast().joined(separator: "/")
    }

    public var breadcrumbs: [FileBreadcrumb] {
        guard currentPath != "." else {
            return [FileBreadcrumb(title: String(localized: "Root"), path: ".")]
        }

        let parts = currentPath.split(separator: "/").map(String.init)
        var breadcrumbs = [FileBreadcrumb(title: String(localized: "Root"), path: ".")]

        for index in parts.indices {
            let title = parts[index]
            let path = parts[...index].joined(separator: "/")
            breadcrumbs.append(FileBreadcrumb(title: title, path: path))
        }

        return breadcrumbs
    }

    public init(session: SessionSummary, server: URL, apiClient: APIClient? = nil) {
        self.session = session
        self.apiClient = apiClient ?? APIClient(baseURL: server)
    }

    @MainActor
    public func loadInitialRootIfNeeded() async {
        guard !hasLoadedInitialPath else { return }
        hasLoadedInitialPath = true
        await loadRoot()
    }

    @MainActor
    public func loadRoot() async {
        await load(path: ".")
    }

    @MainActor
    public func reloadCurrentPath() async {
        await load(path: currentPath)
    }

    @MainActor
    public func retryLastLoad() async {
        await load(path: lastRequestedPath)
    }

    @MainActor
    public func load(path: String) async {
        guard let sessionID = session.sessionId else {
            errorMessage = String(localized: "Session ID is missing.")
            return
        }

        lastRequestedPath = path
        loadRevision += 1
        let revision = loadRevision
        isLoading = true
        errorMessage = nil
        lastError = nil

        do {
            let response = try await apiClient.directoryList(sessionID: sessionID, path: path)
            guard revision == loadRevision else { return }
            currentPath = response.path ?? path
            entries = response.entries ?? []
        } catch {
            guard revision == loadRevision else { return }
            if !APIError.isCancellation(error) {
                lastError = error
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

}

public struct FileBreadcrumb: Identifiable, Equatable {
    public var id: String { path }

    public let title: String
    public let path: String
}
