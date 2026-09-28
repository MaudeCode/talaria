import Foundation

/// Schedules a session-list refresh when the user leaves a destination.
///
/// Leaving any chat — not only a brand new one — can leave its title, message
/// count and activity stale in the list behind it, and in regular width that
/// also covers switching straight from one session to another.
public enum SessionListReturnRefresh {
    public static func run(
        from oldValue: SessionNavigationDestination?,
        to newValue: SessionNavigationDestination?,
        suppressEmptyPlaceholders: () -> Void,
        refreshSessions: () -> Void
    ) {
        // Nothing was left behind: the first destination of a launch has no
        // predecessor to reconcile, and re-selecting the same one changes
        // nothing on the server.
        guard let oldValue, oldValue != newValue else { return }

        if case .newChat = oldValue {
            // Swapping one pending new chat for another never produced a
            // server-side session, so there is nothing newer to adopt.
            if case .newChat = newValue { return }

            // Keep this synchronous so an empty Untitled placeholder cannot flash
            // during the navigation transition. The refresh then adopts the
            // server's latest metadata for a new chat that has become contentful.
            // Only a new chat can strand a placeholder, so other returns skip it.
            suppressEmptyPlaceholders()
        }

        refreshSessions()
    }
}
