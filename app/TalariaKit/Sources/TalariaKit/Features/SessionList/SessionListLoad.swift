import Foundation

public enum SessionListLoad {
    /// Starts the first refresh without waiting for a pending deep link, so a slow
    /// direct session request cannot leave the sidebar empty.
    @MainActor
    public static func initial(
        resolvePendingDeepLink: @escaping @MainActor () async -> Void,
        refreshSessionsAndActiveProfile: @escaping @MainActor () async -> Void
    ) async {
        async let initialRefresh: Void = refreshSessionsAndActiveProfile()
        await resolvePendingDeepLink()
        await initialRefresh
    }

    /// Rows first, then projects and the active profile together: neither depends
    /// on the other. Projects are skipped while the rows came from the offline
    /// cache, since that request would fail the same way.
    @MainActor
    public static func refresh(
        loadRows: @escaping @MainActor () async -> Void,
        isViewingCachedData: @escaping @MainActor () -> Bool,
        loadProjects: @escaping @MainActor () async -> Void,
        loadActiveProfile: @escaping @MainActor () async -> Void
    ) async {
        await loadRows()
        guard !Task.isCancelled else { return }
        async let profile: Void = loadActiveProfile()
        if !isViewingCachedData() { await loadProjects() }
        await profile
    }
}
