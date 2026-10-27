import Foundation

/// TAL-1458: the file a chat's companion page shows beside it. The server names each file call's `focus_path`; this is
/// the device-local state over it: which one the page follows, a file the user pinned, and the page's open browser.
public struct ChatCompanionFocus: Equatable {
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
    /// TAL-1539: the reader hid the page. New files and runs leave it hidden until the reader shows it again.
    public internal(set) var isHidden = false

    public init(isHidden: Bool = false) {
        self.isHidden = isHidden
    }

    /// The file the page shows.
    public var path: String? { pinnedPath ?? followedPath }
    public var isFollowing: Bool { pinnedPath == nil }
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

    public mutating func pin(_ path: String, runID: String?) {
        pinnedPath = path
        pinnedRunID = runID
        browserPath = nil
    }

    public mutating func resumeFollowing() {
        pinnedPath = nil
        pinnedRunID = nil
    }

    /// A run other than the pin's resumes following.
    mutating func runStarted(_ runID: String?) {
        guard pinnedPath != nil, let runID, runID != pinnedRunID else { return }
        resumeFollowing()
    }
}
