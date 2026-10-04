#if DEBUG
import Foundation
import notify

/// Deterministic workspace, file-preview, archived-session and Git responses (TAL-72).
///
/// Opt-in through `--ui-test-workspace` so every existing fixture launch keeps its exact
/// current responses (no repository, no files). `fixture-unreadable.txt` is listed but never
/// reads, so a file preview fails inside a browser that still lists it; the other screens' read
/// failures are view-model tests (TAL-402). `--ui-test-workspace-slow-reads` holds
/// each listing and status read until the test releases it, so its loading state can be observed.
/// Remote Git writes stay rejected until the test posts `grantGitWritesNotification`; the fixture
/// never reaches a real remote, so a push only ever moves fixture state.
extension UITestFixtureURLProtocol {
    enum WorkspaceFixture {
        static let argument = "--ui-test-workspace"
        static let slowReadsArgument = "--ui-test-workspace-slow-reads"
        /// Posted by a UI test to grant the remote Git write capability for the rest of the launch.
        static let grantGitWritesNotification = "dev.kil.talaria.ui-test.grant-git-writes"

        static let directoryName = "fixture-dir"
        static let nestedFileName = "nested-note.txt"
        static let textFileName = "fixture-notes.txt"
        static let imageFileName = "fixture-image.png"
        static let unsupportedFileName = "fixture-archive.zip"
        static let unreadableFileName = "fixture-unreadable.txt"
        static let textFileBody = "FixtureTextPreviewBody\nSecond deterministic line.\n"
        static let branch = "fixture-main"
        static let archivedSessionTitle = "Fixture Archived Session"
        static let writeRejectionMessage = "Fixture git writes are disabled."
        static let pushSuccessMessage = "Fixture push updated 1 ref."
        /// A 16×16 solid PNG, small but real enough for `ImageFilePreview.prepare` to decode.
        static let imageBase64 = """
            iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQqDhBEmIY1TCqYfhq\
            AADDSmgQBaIOewAAAABJRU5ErkJggg==
            """

        static var isEnabled: Bool { hasArgument(argument) }
        static var readsAreSlow: Bool { hasArgument(slowReadsArgument) }
        static var allowsGitWrites: Bool { gitWriteLock.withLock { gitWritesGranted } }

        private static let gitWriteLock = NSLock()
        nonisolated(unsafe) private static var gitWritesGranted = false
        nonisolated(unsafe) private static var gitWriteToken: Int32 = 0

        /// Registers at launch, before any push the test makes.
        static func listenForGitWriteGrant() {
            notify_register_dispatch(grantGitWritesNotification, &gitWriteToken, .global()) { _ in
                gitWriteLock.withLock { gitWritesGranted = true }
            }
        }

        private static func hasArgument(_ argument: String) -> Bool {
            ProcessInfo.processInfo.arguments.contains(argument)
        }
    }

    /// `nil` leaves the request to the base fixture routing.
    static func workspaceResponseData(for request: URLRequest) -> Data? {
        guard let url = request.url else { return nil }

        if isFailingWorkspaceRead(request) {
            return Data(#"{"error":"Fixture read failure"}"#.utf8)
        }
        // Archived rows are only ever requested by the archived-sessions screen, so they
        // need no opt-in: every other launch's session list stays byte-identical.
        if url.path == "/api/sessions", includesArchived(url) {
            return archivedSessionsData()
        }
        guard WorkspaceFixture.isEnabled else { return nil }

        switch url.path {
        case "/api/list":
            return directoryListData(path: queryValue("path", in: url) ?? ".")
        case "/api/file":
            return fileData(path: queryValue("path", in: url) ?? "")
        case "/api/file/raw":
            return Data(base64Encoded: WorkspaceFixture.imageBase64) ?? Data()
        case "/api/git-info":
            return Data("""
            {"git":{"branch":"\(WorkspaceFixture.branch)","dirty":2,"modified":2,"untracked":0,\
            "ahead":1,"behind":0,"is_git":true}}
            """.utf8)
        case "/api/git/status":
            return gitStatusData()
        case "/api/git/branches":
            return Data("""
            {"branches":{"is_git":true,"current":"\(WorkspaceFixture.branch)","detached":false,\
            "upstream":"origin/\(WorkspaceFixture.branch)","ahead":1,"behind":0,\
            "local":[{"name":"\(WorkspaceFixture.branch)"}],"remote":[{"name":"origin/\(WorkspaceFixture.branch)"}]}}
            """.utf8)
        case "/api/git/fetch", "/api/git/pull", "/api/git/push":
            return gitRemoteActionData()
        default:
            return nil
        }
    }

    /// The one read that always fails: a file the browser lists but cannot preview.
    static func isFailingWorkspaceRead(_ request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        return WorkspaceFixture.isEnabled && url.path == "/api/file"
            && queryValue("path", in: url) == WorkspaceFixture.unreadableFileName
    }

    static func workspaceStatusCode(for request: URLRequest) -> Int {
        isFailingWorkspaceRead(request) ? 500 : 200
    }

    static func workspaceContentType(for url: URL) -> String? {
        WorkspaceFixture.isEnabled && url.path == "/api/file/raw" ? "image/png" : nil
    }

    /// Holds every listing and Git status read until the UI test releases it (`UITestFixtureHold`),
    /// so each loading state stays observable without a fixed stall.
    static func holdsWorkspaceRead(for url: URL) -> Bool {
        WorkspaceFixture.isEnabled && WorkspaceFixture.readsAreSlow
            && (url.path == "/api/list" || url.path == "/api/git/status")
    }

    private static func directoryListData(path: String) -> Data {
        let entries: String
        if path == WorkspaceFixture.directoryName {
            entries = """
            {"name":"\(WorkspaceFixture.nestedFileName)",\
            "path":"\(WorkspaceFixture.directoryName)/\(WorkspaceFixture.nestedFileName)",\
            "type":"file","size":48,"is_dir":false}
            """
        } else {
            entries = """
            {"name":"\(WorkspaceFixture.directoryName)","path":"\(WorkspaceFixture.directoryName)",\
            "type":"dir","is_dir":true},\
            {"name":"\(WorkspaceFixture.textFileName)","path":"\(WorkspaceFixture.textFileName)",\
            "type":"file","size":52,"is_dir":false},\
            {"name":"\(WorkspaceFixture.imageFileName)","path":"\(WorkspaceFixture.imageFileName)",\
            "type":"file","size":128,"is_dir":false},\
            {"name":"\(WorkspaceFixture.unsupportedFileName)","path":"\(WorkspaceFixture.unsupportedFileName)",\
            "type":"file","size":256,"is_dir":false},\
            {"name":"\(WorkspaceFixture.unreadableFileName)","path":"\(WorkspaceFixture.unreadableFileName)",\
            "type":"file","size":64,"is_dir":false}
            """
        }
        return Data("""
        {"path":"\(path)","workspace":"/fixture","entries":[\(entries)]}
        """.utf8)
    }

    private static func fileData(path: String) -> Data {
        let content = path.hasSuffix(WorkspaceFixture.nestedFileName)
            ? "FixtureNestedPreviewBody\n"
            : WorkspaceFixture.textFileBody
        let escaped = content.replacingOccurrences(of: "\n", with: "\\n")
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return Data("""
        {"path":"\(path)","name":"\(name)","content":"\(escaped)","size":\(content.utf8.count),"lines":2}
        """.utf8)
    }

    private static func gitStatusData() -> Data {
        Data("""
        {"git":{"is_git":true,"branch":"\(WorkspaceFixture.branch)",\
        "upstream":"origin/\(WorkspaceFixture.branch)","ahead":1,"behind":0,\
        "totals":{"changed":2,"staged":0,"unstaged":2,"untracked":0,"conflicts":0},\
        "truncated":false,"files":[\
        {"path":"\(WorkspaceFixture.textFileName)","status":"M","staged":false,"unstaged":true,\
        "additions":4,"deletions":1},\
        {"path":"\(WorkspaceFixture.directoryName)/\(WorkspaceFixture.nestedFileName)","status":"M",\
        "staged":false,"unstaged":true,"additions":2,"deletions":0}]}}
        """.utf8)
    }

    private static func gitRemoteActionData() -> Data {
        guard WorkspaceFixture.allowsGitWrites else {
            return Data("""
            {"ok":false,"message":"\(WorkspaceFixture.writeRejectionMessage)"}
            """.utf8)
        }
        return Data("""
        {"ok":true,"message":"\(WorkspaceFixture.pushSuccessMessage)"}
        """.utf8)
    }

    private static func archivedSessionsData() -> Data {
        Data("""
        {"archived_count":1,"sessions":[{"session_id":"ui-fixture-archived-session",\
        "title":"\(WorkspaceFixture.archivedSessionTitle)","archived":true,"message_count":3,\
        "last_message_at":2000000000,"workspace":"/fixture","workspace_name":"Fixture Workspace","model":"fixture-model",\
        "model_provider":"fixture-provider","profile":"fixture-profile"}]}
        """.utf8)
    }

    private static func includesArchived(_ url: URL) -> Bool {
        queryValue("include_archived", in: url) == "1"
    }

    private static func queryValue(_ name: String, in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == name }?
            .value
    }
}
#endif
