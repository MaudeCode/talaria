import Foundation

public enum ChatToolbarSubtitleResolver {
    /// `workspaceName` is the server's label for the session's workspace (TAL-303).
    public static func subtitle(workspaceName: String?, profileTitle: String?) -> String? {
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
