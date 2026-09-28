import Foundation

/// Fenced-code languages that should render as display math rather than source
/// code (e.g. ```math, ```latex, ```tex). Models sometimes wrap a standalone
/// equation in a math fence instead of `$$…$$`; those reach the renderer as a
/// code block, so we re-route the math ones (parity-plus over Hermes WebUI,
/// which shows these as code).
public enum MathFenceLanguage {
    static let languages: Set<String> = ["math", "latex", "tex"]

    /// True when a fenced code block's info string names a math language.
    public static func matches(_ language: String?) -> Bool {
        guard let normalized = MarkdownHighlightPolicy.normalizedLanguage(from: language) else {
            return false
        }
        return languages.contains(normalized)
    }
}
