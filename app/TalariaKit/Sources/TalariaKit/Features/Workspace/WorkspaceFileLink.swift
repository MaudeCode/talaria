import Foundation

/// A chat link that names a file in the session workspace: a `file:` URL, an
/// absolute path under the workspace, or an explicit `./`, `../`, or `~/` path,
/// each with an optional `:line[:column]` suffix or `#L12[C3]` fragment.
///
/// `path` is workspace-relative and `/`-joined, the same identity the file
/// browser sends to `/api/file`. The lexical containment check here is only a
/// preflight so an obviously foreign destination keeps the system link
/// behaviour; it cannot see symlinks, so the server stays the authority on what
/// a session may read and its denied/missing errors surface unchanged.
///
/// Bare relative destinations (`src/main.swift`) are not file links: a relative
/// web URL looks the same, so they keep the ordinary link behaviour.
public struct WorkspaceFileLink: Hashable, Identifiable {
    public let path: String
    /// One-based; nil when the destination named no line.
    public let line: Int?

    public var id: String { "\(path):\(line ?? 0)" }

    public var name: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// The transcript renderer hands the tapped destination over as a `URL`;
    /// `absoluteString` keeps positions, fragments, and percent encoding intact.
    public static func parse(_ url: URL, workspaceRoot: String?) -> WorkspaceFileLink? {
        parse(url.absoluteString, workspaceRoot: workspaceRoot)
    }

    /// Nil when the destination is not a file link, the workspace root is
    /// unknown, or the path lexically resolves outside the workspace. A root of
    /// `/` is a valid, if unusual, workspace.
    public static func parse(_ destination: String, workspaceRoot: String?) -> WorkspaceFileLink? {
        guard let rootComponents = components(ofAbsolutePath: workspaceRoot ?? ""),
              let target = fileTarget(of: destination.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return nil }

        let position = splitPosition(path: target.path, fragment: target.fragment)
        guard let absolute = absoluteComponents(for: position.path, rootComponents: rootComponents),
              absolute.count > rootComponents.count,
              absolute.starts(with: rootComponents)
        else { return nil }

        return WorkspaceFileLink(
            path: absolute.dropFirst(rootComponents.count).joined(separator: "/"),
            line: position.line
        )
    }

    // MARK: - Parsing

    private struct Target {
        let path: String
        let fragment: String
    }

    /// The decoded path and fragment of a destination that could name a file;
    /// nil for any other scheme or an unaccepted prefix.
    private static func fileTarget(of destination: String) -> Target? {
        if destination.lowercased().hasPrefix("file:") {
            guard let url = URL(string: destination), url.scheme?.lowercased() == "file" else { return nil }
            // A file on another host is not this workspace's file.
            let host = (url.host() ?? "").lowercased()
            guard host.isEmpty || host == "localhost" else { return nil }
            let path = url.path(percentEncoded: false)
            guard path.hasPrefix("/") else { return nil }
            return Target(path: path, fragment: url.fragment(percentEncoded: false) ?? "")
        }

        // `//host/path` is a protocol-relative web link, never a file.
        guard !destination.hasPrefix("//"),
              ["/", "./", "../", "~/"].contains(where: destination.hasPrefix)
        else { return nil }

        var path = destination
        var fragment = ""
        if let hashIndex = path.firstIndex(of: "#") {
            fragment = String(path[path.index(after: hashIndex)...])
            path = String(path[..<hashIndex])
        }
        if let queryIndex = path.firstIndex(of: "?") {
            path = String(path[..<queryIndex])
        }
        return Target(
            path: path.removingPercentEncoding ?? path,
            fragment: fragment.removingPercentEncoding ?? fragment
        )
    }

    /// Strips `:line[:column]` from the path, or reads `L12[C3]` from the
    /// fragment when the path carries no suffix. Zero and negative lines are
    /// dropped; a column is accepted so the path parses, but not kept.
    private static func splitPosition(path: String, fragment: String) -> (path: String, line: Int?) {
        if let match = path.firstMatch(of: /:(\d+)(?::\d+)?$/) {
            return (String(path[..<match.range.lowerBound]), positiveInt(match.1))
        }
        if let match = fragment.firstMatch(of: /^L(\d+)(?:C\d+)?$/.ignoresCase()) {
            return (path, positiveInt(match.1))
        }
        return (path, nil)
    }

    private static func positiveInt(_ digits: Substring) -> Int? {
        guard let value = Int(digits), value > 0 else { return nil }
        return value
    }

    /// `~/` expands to the home directory the workspace root sits in
    /// (`/Users/<name>` or `/home/<name>`); `./` and `../` start at the root.
    private static func absoluteComponents(for path: String, rootComponents: [String]) -> [String]? {
        if path.hasPrefix("/") {
            return components(ofAbsolutePath: path)
        }
        if path.hasPrefix("~/") {
            guard rootComponents.count >= 2, ["Users", "home"].contains(rootComponents[0]) else { return nil }
            return normalize(Array(rootComponents.prefix(2)) + path.dropFirst(2).split(separator: "/").map(String.init))
        }
        return normalize(rootComponents + path.split(separator: "/").map(String.init))
    }

    private static func components(ofAbsolutePath path: String) -> [String]? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        return normalize(trimmed.split(separator: "/").map(String.init))
    }

    /// Collapses `.` and `..`; nil when `..` would climb above the filesystem root.
    private static func normalize(_ components: [String]) -> [String]? {
        var result: [String] = []
        for component in components {
            switch component {
            case "", ".":
                continue
            case "..":
                guard result.popLast() != nil else { return nil }
            default:
                result.append(component)
            }
        }
        return result
    }
}
