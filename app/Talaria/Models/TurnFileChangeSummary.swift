import Foundation

// In-chat "N files changed" recap (issue #316, Workspace git Slice D).
//
// The server attributes a settled turn's file changes from its file-mutating calls and
// ships them as `file_changes` on the turn's activity scene (TAL-355) — a `git/status`
// snapshot can't isolate a single turn's edits from accumulated uncommitted/external
// changes. Each server path is joined to `git/status` for the `+N −M` line counts and the
// status chip.

/// A single file changed during one assistant turn.
struct TurnFileChange: Identifiable, Equatable {
    /// The server's normalized path, workspace-relative or absolute as the tool reported it.
    let path: String
    /// Added lines, from the matched `git/status` entry (`0` when there is no net change).
    let additions: Int
    /// Removed lines, from the matched `git/status` entry (`0` when there is no net change).
    let deletions: Int
    /// What the turn did to the file, as the server attributed it (drives the fallback chip).
    let action: Action
    /// Status chip kind — the matched `git/status` kind when available, else derived
    /// from `action`.
    let changeKind: GitFile.ChangeKind
    /// The matched `git/status` file, when one exists. `nil` for a tool-touched path with
    /// no net git change (the row then shows `+0 −0` and is not openable in the diff sheet).
    let gitFile: GitFile?

    var id: String { path }

    /// Last path component, e.g. `ContentView.swift`.
    var fileName: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    enum Action: String, Codable, Equatable {
        case edited
        case added
        case deleted
        case renamed

        /// Fallback chip kind when the path didn't match a `git/status` entry.
        var changeKind: GitFile.ChangeKind {
            switch self {
            case .edited: return .modified
            case .added: return .added
            case .deleted: return .deleted
            case .renamed: return .renamed
            }
        }
    }
}

/// Aggregated per-turn file-change recap. An empty `changes` array means "show nothing"
/// (a turn that changed no files, or a non-git workspace).
struct TurnFileChangeSummary: Equatable {
    let changes: [TurnFileChange]

    static let empty = TurnFileChangeSummary(changes: [])

    var fileCount: Int { changes.count }
    var hasChanges: Bool { !changes.isEmpty }
    var totalAdditions: Int { changes.reduce(0) { $0 + $1.additions } }
    var totalDeletions: Int { changes.reduce(0) { $0 + $1.deletions } }

    /// `git/status` files backing the changes, for opening the per-turn diff sheet.
    var diffFiles: [GitFile] { changes.compactMap(\.gitFile) }

    /// Compact composer-capsule title, e.g. "1 change" / "3 changes".
    var capsuleTitle: String {
        fileCount == 1
            ? String(localized: "1 change")
            : String(localized: "\(fileCount) changes")
    }

    /// Sheet/header title, e.g. "1 file changed" / "3 files changed".
    var filesChangedTitle: String {
        fileCount == 1
            ? String(localized: "1 file changed")
            : String(localized: "\(fileCount) files changed")
    }
}

/// One file the server attributed to a settled turn (`_anchor_activity_scene.file_changes`).
struct AssistantTurnFileChange: Codable, Equatable {
    let path: String
    let action: TurnFileChange.Action

    /// Entries decode one by one, so a malformed or newer-action entry never drops its neighbours.
    static func decodeLossily(_ values: [JSONValue]) -> [AssistantTurnFileChange] {
        values.compactMap { value in
            guard case .object(let object) = value,
                  case .string(let path)? = object["path"], !path.isEmpty,
                  case .string(let rawAction)? = object["action"],
                  let action = TurnFileChange.Action(rawValue: rawAction)
            else { return nil }
            return AssistantTurnFileChange(path: path, action: action)
        }
    }
}

/// Joins the server's per-turn file changes to `git/status` for line counts and chips.
/// Stateless and deterministic so it can be unit-tested in isolation.
enum TurnFileChangeAggregator {
    /// Build the recap for one settled assistant turn.
    /// - Parameters:
    ///   - changes: the turn scene's server-attributed `file_changes`.
    ///   - status: the latest `git/status`, joined for line counts and chips (`nil` ok).
    static func summarize(changes: [AssistantTurnFileChange], status: GitStatus?) -> TurnFileChangeSummary {
        let trackedFiles = status?.trackedFiles ?? []
        return TurnFileChangeSummary(changes: changes.map { change in
            let match = matchingFile(for: change.path, in: trackedFiles)
            return TurnFileChange(
                path: change.path,
                additions: match?.additions ?? 0,
                deletions: match?.deletions ?? 0,
                action: change.action,
                changeKind: match?.changeKind ?? change.action.changeKind,
                gitFile: match
            )
        })
    }

    // MARK: - git/status join

    /// Find the `git/status` entry for a server path, tolerating absolute-vs-relative
    /// references to the same repo file.
    private static func matchingFile(for path: String, in files: [GitFile]) -> GitFile? {
        if let exact = files.first(where: { $0.displayPath == path }) {
            return exact
        }
        return files.first { representsSameFile($0.displayPath, path) }
    }

    /// True when two normalized paths point at the same file — equal, or one is the
    /// absolute form of the other (suffix match on a `/`-boundary). The suffix checks are
    /// gated on the longer path being absolute so two distinct *relative* paths that merely
    /// share a trailing component (e.g. `other/App.swift` vs `some/other/App.swift`) never
    /// falsely match.
    private static func representsSameFile(_ lhs: String, _ rhs: String) -> Bool {
        guard !lhs.isEmpty, !rhs.isEmpty else { return false }
        if lhs == rhs { return true }
        if lhs.hasPrefix("/"), lhs.hasSuffix("/" + rhs) { return true }
        if rhs.hasPrefix("/"), rhs.hasSuffix("/" + lhs) { return true }
        return false
    }
}
