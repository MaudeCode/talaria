import Foundation

enum SessionListInitialLoad {
    @MainActor
    static func run(
        resolvePendingDeepLink: @escaping @MainActor () async -> Void,
        refreshSessionsAndActiveProfile: @escaping @MainActor () async -> Void
    ) async {
        async let initialRefresh: Void = refreshSessionsAndActiveProfile()
        await resolvePendingDeepLink()
        await initialRefresh
    }
}
