import Foundation

enum SessionListNewChatReturn {
    static func run(
        from oldValue: SessionNavigationDestination?,
        to newValue: SessionNavigationDestination?,
        suppressEmptyPlaceholders: () -> Void,
        refreshSessions: () -> Void
    ) {
        guard case .newChat = oldValue else { return }
        if case .newChat = newValue { return }

        // Keep this synchronous so an empty Untitled placeholder cannot flash
        // during the navigation transition. The refresh then adopts the server's
        // latest metadata for a new chat that has become contentful.
        suppressEmptyPlaceholders()
        refreshSessions()
    }
}
