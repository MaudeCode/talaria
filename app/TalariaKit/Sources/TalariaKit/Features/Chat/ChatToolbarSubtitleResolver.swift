import Foundation

public enum ChatToolbarSubtitleResolver {
    /// `workspaceName` is the server's label for the session's workspace (TAL-303). A chat the server created in a
    /// diagnostic `executionMode` leads with it (TAL-1045), so the frozen mode shows wherever the chat does.
    public static func subtitle(workspaceName: String?, profileTitle: String?, executionMode: ExecutionMode? = nil) -> String? {
        let place = placeSubtitle(workspaceName: workspaceName, profileTitle: profileTitle)
        guard let executionMode, executionMode.isDiagnostic else { return place }
        return [executionMode.title, place].compactMap { $0 }.joined(separator: " · ")
    }

    private static func placeSubtitle(workspaceName: String?, profileTitle: String?) -> String? {
        if let workspace = nonEmpty(workspaceName) {
            return workspace
        }

        guard let profile = nonEmpty(profileTitle), profile != "Profile" else {
            return nil
        }

        return profile
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
