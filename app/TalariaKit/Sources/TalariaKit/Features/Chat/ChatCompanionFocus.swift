import Foundation

/// TAL-1458: the file a chat's companion page shows beside it. The server names each file call's `focus_path`; this is
/// the device-local state over it: which one the page follows, a file the user pinned, and the page's open browser.
/// TAL-1478: a tool call's result or a turn's changes the reader opened on the page, over that file.
public struct ChatCompanionFocus: Equatable, Sendable {
    /// What the page shows over its file.
    public enum Shown: Equatable, Sendable {
        /// The call as its card last saw it, so a running call's result fills in.
        case toolResult(ToolCall)
        /// The turn's changed files, and the one whose diff is open.
        case turnChanges([GitFile], opened: GitFile?)
    }

    /// The latest file a tool frame named, seeded by the session's `focus_path`.
    public private(set) var followedPath: String?
    /// The followed file's change, while the latest frame naming it carries one.
    public private(set) var editDiff: ToolEditDiff?
    /// Counts the edits that landed, so the page reloads a file the agent rewrote.
    public private(set) var editRevision = 0
    /// A file chosen in the browser. Following pauses until another run starts.
    public private(set) var pinnedPath: String?
    /// The run the pin was made in; nil when the chat was idle.
    private var pinnedRunID: String?
    /// The live call that named the followed file, whose completion brings its change.
    private var followedCallID: String?
    /// The latest live call, so a completion of an earlier one does not turn the page back.
    private var latestCallID: String?
    /// The directory the page's file browser shows; nil when the page shows its file.
    public var browserPath: String?
    /// TAL-1478: a tool result or a turn's changes over the file; nil shows the file.
    public private(set) var shown: Shown?
    /// TAL-1539: the reader hid the page. New files and runs leave it hidden until the reader shows it again.
    public internal(set) var isHidden = false

    public init(isHidden: Bool = false) {
        self.isHidden = isHidden
    }

    /// The file the page shows.
    public var path: String? { pinnedPath ?? followedPath }
    public var isFollowing: Bool { pinnedPath == nil && shown == nil }
    /// The tool call whose result the page shows, if any.
    public var shownToolCallID: String? {
        guard case .toolResult(let call) = shown else { return nil }
        return call.id
    }
    /// The shown file's latest change; a pinned file shows none.
    public var shownEditDiff: ToolEditDiff? { isFollowing ? editDiff : nil }

    /// A tool frame or session detail naming a file moves the followed page to it; one naming none leaves it.
    mutating func follow(_ path: String?, callID: String? = nil) {
        if callID != nil { latestCallID = callID }
        guard let path, !path.isEmpty else { return }
        followedPath = path
        followedCallID = callID
        editDiff = nil
    }

    /// A completion carries the call's change. A bare one (no arguments, so no `focus_path`) names its call by id.
    mutating func complete(_ path: String?, callID: String?, editDiff: ToolEditDiff?) {
        if path?.isEmpty == false, callID == nil || callID == latestCallID {
            follow(path, callID: callID)
        } else if callID == nil || callID != followedCallID {
            return
        }
        self.editDiff = editDiff
        editRevision += 1
    }

    /// The session detail's file moves the page unless a live call in this chat named one since.
    mutating func seed(_ path: String?) {
        guard followedCallID == nil, path != followedPath else { return }
        follow(path)
    }

    /// A chat rebuilt from memory missed the stream meanwhile, so the next session detail names the latest file.
    mutating func forgetLiveCalls() {
        followedCallID = nil
        latestCallID = nil
    }

    /// A chosen file replaces a tool result or turn's changes the page showed.
    public mutating func pin(_ path: String, runID: String?) {
        pinnedPath = path
        pinnedRunID = runID
        browserPath = nil
        shown = nil
    }

    public mutating func resumeFollowing() {
        pinnedPath = nil
        pinnedRunID = nil
        shown = nil
    }

    /// TAL-1478: a tool result or a turn's changes pin the page as a chosen file does. The call the page already shows
    /// only takes its newer state, so its card's updates keep the page current without re-pinning it.
    public mutating func show(_ shown: Shown, runID: String?) {
        if case .toolResult(let call) = shown, call.id == shownToolCallID {
            self.shown = shown
            return
        }
        if self.shown == nil, pinnedPath == nil { pinnedRunID = runID }
        self.shown = shown
        browserPath = nil
    }

    /// One step back: from a changed file's diff to the turn's list, from a tool result or the list to the file.
    public mutating func back() {
        if case .turnChanges(let files, opened: .some) = shown {
            shown = .turnChanges(files, opened: nil)
            return
        }
        shown = nil
        if pinnedPath == nil { pinnedRunID = nil }
    }

    /// A run other than the pin's resumes following.
    mutating func runStarted(_ runID: String?) {
        guard !isFollowing, let runID, runID != pinnedRunID else { return }
        resumeFollowing()
    }
}
