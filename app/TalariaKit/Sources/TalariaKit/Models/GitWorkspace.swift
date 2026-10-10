import Foundation

// Tolerant, read-only models for the server "workspace git" API (issue #312, Slice A).
//
// Every field is optional and unknown keys are ignored so the app never crashes on a
// field the server adds or renames (hard rule #3). The shared `APIClient` decoder uses
// `.convertFromSnakeCase`, so snake_case JSON keys (`is_git`, `old_path`, `too_large`, …)
// map onto these camelCase properties automatically.
//
// Endpoint contract (verified against `.codex-tmp/hermes-webui/api/workspace_git.py`):
// - GET /api/git-info  → { "git": {...} | null }
// - GET /api/git/status → { "git": {...} }   (non-repo: is_git=false, HTTP 200)
// - GET /api/git/branches → { "branches": {...} } (non-repo: HTTP 400 error envelope)
// - GET /api/git/diff → { "diff": {...} }    (non-repo / missing path: HTTP 400)

// MARK: - git-info (lightweight badge data)

public struct GitInfoResponse: Decodable, Equatable {
    /// `null` when the session workspace is not a git repository.
    public let git: GitInfo?
}

public struct GitInfo: Decodable, Equatable {
    public let branch: String?
    public let dirty: Int?
    let modified: Int?
    let untracked: Int?
    public let ahead: Int?
    public let behind: Int?
    public let isGit: Bool?
}

// MARK: - git/status (the status sheet's source of truth)

public struct GitStatusResponse: Decodable, Equatable {
    public let git: GitStatus?
}

public struct GitStatus: Decodable, Equatable {
    /// `false` for a non-repo workspace (still an HTTP 200 response).
    public let isGit: Bool?
    public let branch: String?
    let upstream: String?
    public let ahead: Int?
    public let behind: Int?
    let totals: GitTotals?
    let files: [GitFile]?
    /// `true` when the file list was capped (server limit is 500 changed files).
    public let truncated: Bool?

    /// Changed files excluding ignored entries (e.g. `.DS_Store`), which the server
    /// includes in `files[]` but excludes from `totals.changed`.
    public var trackedFiles: [GitFile] {
        (files ?? []).filter { !$0.isIgnoredFile }
    }

    /// Changed-file count, preferring the server's `totals.changed` and falling back to
    /// the non-ignored file count so the header never disagrees with the list.
    public var changedCount: Int {
        totals?.changed ?? trackedFiles.count
    }

    /// Total additions/deletions across non-ignored files.
    public var totalAdditions: Int { trackedFiles.reduce(0) { $0 + ($1.additions ?? 0) } }
    public var totalDeletions: Int { trackedFiles.reduce(0) { $0 + ($1.deletions ?? 0) } }
}

struct GitTotals: Decodable, Equatable {
    let changed: Int?
    let staged: Int?
    let unstaged: Int?
    let untracked: Int?
    let conflicts: Int?
}

public struct GitFile: Decodable, Equatable, Identifiable {
    public let id: String
    public let path: String?
    let oldPath: String?
    public let workspacePath: String?
    /// Raw git status code (`M/A/D/R/C/T/U`, `"??"`, two-char conflicts, or `"Ignored"`).
    /// Prefer the booleans below for display; treat this as a fallback label.
    public let status: String?
    public let staged: Bool?
    let unstaged: Bool?
    public let untracked: Bool?
    let ignored: Bool?
    let conflict: Bool?
    public let additions: Int?
    public let deletions: Int?
    let binary: Bool?

    enum CodingKeys: String, CodingKey {
        case path
        case oldPath
        case workspacePath
        case status
        case staged
        case unstaged
        case untracked
        case ignored
        case conflict
        case additions
        case deletions
        case binary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = container.decodeLossyStringIfPresent(forKey: .path)
        oldPath = container.decodeLossyStringIfPresent(forKey: .oldPath)
        workspacePath = container.decodeLossyStringIfPresent(forKey: .workspacePath)
        status = container.decodeLossyStringIfPresent(forKey: .status)
        staged = container.decodeLossyBoolIfPresent(forKey: .staged)
        unstaged = container.decodeLossyBoolIfPresent(forKey: .unstaged)
        untracked = container.decodeLossyBoolIfPresent(forKey: .untracked)
        ignored = container.decodeLossyBoolIfPresent(forKey: .ignored)
        conflict = container.decodeLossyBoolIfPresent(forKey: .conflict)
        additions = container.decodeLossyIntIfPresent(forKey: .additions)
        deletions = container.decodeLossyIntIfPresent(forKey: .deletions)
        binary = container.decodeLossyBoolIfPresent(forKey: .binary)

        if let stablePath = Self.stablePath(path: path, workspacePath: workspacePath, oldPath: oldPath) {
            id = stablePath
        } else {
            id = UUID().uuidString
        }
    }

    private static func stablePath(path: String?, workspacePath: String?, oldPath: String?) -> String? {
        let candidate = [path, workspacePath, oldPath]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return candidate
    }
}

extension GitFile {
    /// A normalized change kind derived from the booleans first (the reliable signal),
    /// falling back to the raw `status` code. UI maps this to a localized chip + colour.
    public enum ChangeKind: Equatable {
        case conflict
        case untracked
        case added
        case deleted
        case renamed
        case modified
        case ignored
        case unknown
    }

    public var changeKind: ChangeKind {
        if conflict == true { return .conflict }
        if isIgnoredFile { return .ignored }
        if untracked == true { return .untracked }

        switch (status ?? "").uppercased().first {
        case "A": return .added
        case "D": return .deleted
        case "R": return .renamed
        case "M", "T": return .modified
        default:
            // A tracked change with an unrecognized code is still a modification.
            return (staged == true || unstaged == true) ? .modified : .unknown
        }
    }

    /// Last path component, e.g. `ContentView.swift`.
    public var fileName: String {
        let value = displayPath
        return value.split(separator: "/").last.map(String.init) ?? value
    }

    /// Parent directory shown as secondary text, or `nil` at the repo root.
    public var parentDirectory: String? {
        let parts = displayPath.split(separator: "/").map(String.init)
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }

    /// The diff query uses staged content for staged-only changes, unstaged otherwise.
    public var preferredDiffKind: String {
        (staged == true && unstaged != true) ? "staged" : "unstaged"
    }

    public var displayPath: String {
        let trimmed = (path ?? workspacePath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? (oldPath ?? "") : trimmed
    }

    var isIgnoredFile: Bool {
        ignored == true || (status ?? "").caseInsensitiveCompare("Ignored") == .orderedSame
    }
}

// MARK: - git/branches (decoded + tested now; interactive picker is Slice B)

public struct GitBranchesResponse: Decodable, Equatable {
    public let branches: GitBranches?
}

public struct GitBranches: Decodable, Equatable {
    let isGit: Bool?
    public let current: String?
    let detached: Bool?
    let head: String?
    public let local: [GitBranchRef]?
    public let remote: [GitBranchRef]?
    let upstream: String?
    let ahead: Int?
    let behind: Int?
}

public struct GitBranchRef: Decodable, Equatable {
    public let name: String?
    let sha: String?
    let updated: Int?
    let updatedRelative: String?
    let author: String?
    public let subject: String?
    let upstream: String?
    public let ahead: Int?
    public let behind: Int?
}

public enum GitBranchMode: String, Equatable {
    case local
    case remote
}

public struct GitCheckoutTarget: Equatable, Identifiable {
    let ref: String
    let mode: GitBranchMode
    var newBranch: String? = nil
    var track = false

    public init(ref: String, mode: GitBranchMode, newBranch: String? = nil, track: Bool = false) {
        self.ref = ref
        self.mode = mode
        self.newBranch = newBranch
        self.track = track
    }

    public var id: String { "\(mode.rawValue):\(ref):\(newBranch ?? "")" }
    public var displayName: String { newBranch ?? ref }
}

public struct GitRemoteActionResponse: Decodable, Equatable {
    public let ok: Bool?
    public let message: String?
    public let status: GitStatus?
}

/// Both checkout endpoints currently return `status`; `git` is retained as a tolerant
/// alias for servers that shipped the earlier documented response name.
public struct GitCheckoutResponse: Decodable, Equatable {
    public let ok: Bool?
    public let message: String?
    let status: GitStatus?
    let git: GitStatus?
    public let branches: GitBranches?
    let currentBranch: String?
    let stashName: String?
    let stashed: Bool?
    let restoredStash: GitRestoredStash?
    public let restoreFailed: Bool?
    public let restoreError: String?
    let restoreStash: GitRestoredStash?

    public var resolvedStatus: GitStatus? { status ?? git }
}

struct GitRestoredStash: Decodable, Equatable {
    let ref: String?
    let branch: String?
    let message: String?
}

// MARK: - git stage/unstage/discard/commit (issue #315, Slice C)

/// Response for `stage` / `unstage` / `discard`, which return the refreshed status under
/// the `git` key (the commit endpoints return it under `status` instead — see below).
public struct GitMutationResponse: Decodable, Equatable {
    public let ok: Bool?
    public let message: String?
    let git: GitStatus?

    public var resolvedStatus: GitStatus? { git }
}

/// Response for `commit` (`{ok,commit,status}`) and `commit-selected`
/// (`{ok,commit,paths,status}`). Tolerant: `status` is decoded from either key.
public struct GitCommitResponse: Decodable, Equatable {
    public let ok: Bool?
    public let message: String?
    let commit: String?
    let paths: [String]?
    let status: GitStatus?
    let git: GitStatus?

    public var resolvedStatus: GitStatus? { status ?? git }
    /// Short SHA produced by the commit, trimmed for display.
    public var shortSHA: String? {
        let trimmed = commit?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed : nil
    }
}

/// Response for the (ungated) `commit-message` / `commit-message-selected` endpoints.
public struct GitCommitMessageResponse: Decodable, Equatable {
    let ok: Bool?
    public let message: String?
    /// `true` when the diff exceeded the server's 64 KiB prompt limit, so the
    /// generated message may be partial.
    public let truncated: Bool?
}

// MARK: - git/diff (per-file unified diff)

public struct GitDiffResponse: Decodable, Equatable {
    public let diff: GitDiff?
}

public struct GitDiff: Decodable, Equatable {
    let path: String?
    let kind: String?
    public let binary: Bool?
    /// `true` when the diff exceeded the server's 512 KiB cap; it then ships no `hunks`.
    public let tooLarge: Bool?
    public let additions: Int
    public let deletions: Int
    /// Unified diff text. Empty for binary diffs.
    public let diff: String?
    /// The diff's hunks, parsed on the server (TAL-604).
    public let hunks: [DiffHunk]

    enum CodingKeys: String, CodingKey {
        case path, kind, binary, tooLarge, additions, deletions, diff, hunks
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decodeIfPresent(String.self, forKey: .path)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        binary = try container.decodeIfPresent(Bool.self, forKey: .binary)
        tooLarge = try container.decodeIfPresent(Bool.self, forKey: .tooLarge)
        additions = try container.decode(Int.self, forKey: .additions)
        deletions = try container.decode(Int.self, forKey: .deletions)
        diff = try container.decodeIfPresent(String.self, forKey: .diff)
        hunks = DiffHunk.resolved(try container.decodeIfPresent(JSONValue.self, forKey: .hunks), diff: diff ?? "")
    }
}
