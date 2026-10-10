import XCTest
@testable import TalariaKit

/// View-model behaviour + diff parsing for the workspace-git feature (issue #312, Slice A).
final class GitWorkspaceViewModelTests: APIClientTestCase {

    private func session(id: String) throws -> SessionSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            SessionSummary.self,
            from: Data(#"{"session_id": "\#(id)", "title": "T", "workspace": "/tmp/\#(id)"}"#.utf8)
        )
    }

    private static let statusWithIgnored = """
    {
      "git": {
        "is_git": true, "branch": "main",
        "totals": {"changed": 1},
        "files": [
          {"path": "a.swift", "status": "M", "unstaged": true, "additions": 3, "deletions": 1, "ignored": false},
          {"path": ".DS_Store", "status": "Ignored", "ignored": true, "additions": 0, "deletions": 0}
        ],
        "truncated": false
      }
    }
    """

    // MARK: - Loading

    @MainActor
    func testLoadExcludesIgnoredFilesFromCountsAndTotals() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(Self.statusWithIgnored, for: request)
        }
        let viewModel = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.load()

        XCTAssertTrue(viewModel.hasRepository)
        XCTAssertFalse(viewModel.isNonRepository)
        let status = try XCTUnwrap(viewModel.status)
        XCTAssertEqual(status.files?.count, 2)
        XCTAssertEqual(status.trackedFiles.count, 1)
        XCTAssertEqual(status.changedCount, 1)
        XCTAssertEqual(status.totalAdditions, 3)
        XCTAssertEqual(status.totalDeletions, 1)
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testRefreshReplacesStaleData() async throws {
        var dirty = true
        let client = makeClient { request in
            let json = dirty ? Self.statusWithIgnored : #"{"git": {"is_git": true, "branch": "main", "files": [], "totals": {"changed": 0}}}"#
            return apiTestJSONResponse(json, for: request)
        }
        let viewModel = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.load()
        XCTAssertEqual(viewModel.status?.trackedFiles.count, 1)

        dirty = false
        await viewModel.load()
        XCTAssertEqual(viewModel.status?.trackedFiles.count, 0, "Refreshing replaces, not appends.")
        XCTAssertEqual(viewModel.status?.changedCount, 0)
    }

    @MainActor
    func testDifferentSessionsHaveIndependentState() async throws {
        // One handler that answers per session_id; two view models, each scoped to its session.
        let client = makeClient { request in
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            let sessionID = components?.queryItems?.first { $0.name == "session_id" }?.value
            let branch = sessionID == "s1" ? "main" : "feature/x"
            return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "\#(branch)", "files": []}}"#, for: request)
        }

        let vm1 = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        let vm2 = GitWorkspaceViewModel(session: try session(id: "s2"), server: URL(string: "https://example.test")!, apiClient: client)

        await vm1.load()
        await vm2.load()

        XCTAssertEqual(vm1.status?.branch, "main")
        XCTAssertEqual(vm2.status?.branch, "feature/x")
    }

    @MainActor
    func testLoadIfNeededLoadsOnlyOnce() async throws {
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main", "files": []}}"#, for: request)
        }
        let viewModel = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.loadIfNeeded()
        await viewModel.loadIfNeeded()

        XCTAssertEqual(requestCount, 1)
    }

    @MainActor
    func testLoadIfNeededRetriesAfterTransientFailure() async throws {
        var shouldFail = true
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            if shouldFail {
                shouldFail = false
                let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error": "boom"}"#.utf8))
            }

            return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main", "files": []}}"#, for: request)
        }
        let viewModel = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.loadIfNeeded()
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertEqual(requestCount, 1)

        await viewModel.loadIfNeeded()

        XCTAssertEqual(requestCount, 2)
        XCTAssertEqual(viewModel.status?.branch, "main")
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testNonRepositoryWorkspaceSetsEmptyState() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"git": {"is_git": false}}"#, for: request)
        }
        let viewModel = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.load()

        XCTAssertTrue(viewModel.isNonRepository)
        XCTAssertFalse(viewModel.hasRepository)
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testLoadSurfacesErrorOnHTTPFailure() async throws {
        let client = makeClient { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"error": "boom"}"#.utf8))
        }
        let viewModel = GitWorkspaceViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.load()

        XCTAssertNil(viewModel.status)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
    }

    // MARK: - Toolbar availability

    @MainActor
    func testAvailabilityShowsOnlyWhenGitInfoConfirmsRepository() async throws {
        let client = makeClient { request in
            if request.url?.path == "/api/git-info" {
                return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main"}}"#, for: request)
            }
            if request.url?.path == "/api/git/status" {
                return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main", "files": []}}"#, for: request)
            }
            XCTAssertEqual(request.url?.path, "/api/git/branches")
            return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main"}}"#, for: request)
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        XCTAssertFalse(viewModel.hasRepository)

        await viewModel.load()

        XCTAssertTrue(viewModel.hasRepository)
        XCTAssertEqual(viewModel.status?.changedCount, 0)
        XCTAssertNil(viewModel.lastError)
    }

    func testToolbarPresentationMapsRepositoryStates() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func info(_ json: String) throws -> GitInfo? {
            try decoder.decode(GitInfoResponse.self, from: Data(json.utf8)).git
        }

        let dirty = try info(#"{"git":{"is_git":true,"dirty":2,"behind":0}}"#)
        let behind = try info(#"{"git":{"is_git":true,"dirty":0,"behind":1}}"#)
        let clean = try info(#"{"git":{"is_git":true,"dirty":0,"behind":0}}"#)

        XCTAssertEqual(GitToolbarPresentation(hasRepository: true, isLoading: false, info: dirty, status: nil, statusFailed: false).statusDot, .gray)
        XCTAssertEqual(GitToolbarPresentation(hasRepository: true, isLoading: false, info: behind, status: nil, statusFailed: false).statusDot, .gray)
        XCTAssertNil(GitToolbarPresentation(hasRepository: true, isLoading: false, info: clean, status: nil, statusFailed: false).statusDot)
        XCTAssertNil(GitToolbarPresentation(hasRepository: false, isLoading: false, info: dirty, status: nil, statusFailed: false).statusDot)
    }

    func testToolbarPresentationEnablesChangesAfterStatusFailure() {
        let failed = GitToolbarPresentation(
            hasRepository: true,
            isLoading: false,
            info: nil,
            status: nil,
            statusFailed: true
        )
        let loading = GitToolbarPresentation(
            hasRepository: true,
            isLoading: true,
            info: nil,
            status: nil,
            statusFailed: true
        )

        XCTAssertTrue(failed.changesAreEnabled, "The status sheet provides the manual retry path.")
        XCTAssertFalse(loading.changesAreEnabled)
    }

    @MainActor
    func testAvailabilityHidesForNonRepositoryAndNullGitInfo() async throws {
        var returnsNullGit = false
        let client = makeClient { request in
            let json = returnsNullGit ? #"{"git": null}"# : #"{"git": {"is_git": false}}"#
            return apiTestJSONResponse(json, for: request)
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.load()
        XCTAssertFalse(viewModel.hasRepository)

        returnsNullGit = true
        await viewModel.load()
        XCTAssertFalse(viewModel.hasRepository)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testAvailabilityHidesOnHTTPFailure() async throws {
        let client = makeClient { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"error": "boom"}"#.utf8))
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.load()

        XCTAssertFalse(viewModel.hasRepository)
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testAvailabilityLoadIfNeededRetriesAfterTransientFailure() async throws {
        var shouldFail = true
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            if shouldFail {
                shouldFail = false
                let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error": "boom"}"#.utf8))
            }

            return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main"}}"#, for: request)
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.loadIfNeeded()
        XCTAssertFalse(viewModel.hasRepository)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertEqual(requestCount, 1)

        await viewModel.loadIfNeeded()

        XCTAssertEqual(requestCount, 4, "Successful availability also loads menu status and branches.")
        XCTAssertTrue(viewModel.hasRepository)
        XCTAssertNil(viewModel.lastError)
    }

    @MainActor
    func testAvailabilityLoadIfNeededRetriesAfterTransientStatusFailure() async throws {
        var statusShouldFail = true
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            if request.url?.path == "/api/git-info" {
                return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main"}}"#, for: request)
            }
            if statusShouldFail {
                statusShouldFail = false
                let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error": "boom"}"#.utf8))
            }
            return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "main", "files": []}}"#, for: request)
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)

        await viewModel.loadIfNeeded()
        XCTAssertTrue(viewModel.hasRepository)
        XCTAssertNil(viewModel.status)
        XCTAssertNotNil(viewModel.statusError)

        await viewModel.loadIfNeeded()

        XCTAssertEqual(requestCount, 5)
        XCTAssertEqual(viewModel.status?.changedCount, 0)
        XCTAssertNil(viewModel.statusError)
    }

    @MainActor
    func testAvailabilityLoadsBranchesAndCheckoutRefreshesSharedState() async throws {
        // Stateful mock: the server reflects the new current branch on every read after a
        // checkout, so the post-checkout branch reload sees "feature", not stale "main".
        var currentBranch = "main"
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"\#(currentBranch)"}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"\#(currentBranch)","files":[]}}"#, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"\#(currentBranch)","local":[{"name":"main"},{"name":"feature"}],"remote":[]}}"#, for: request)
            case "/api/git/checkout":
                currentBranch = "feature"
                return apiTestJSONResponse(#"{"ok":true,"current_branch":"feature","status":{"is_git":true,"branch":"feature"},"branches":{"is_git":true,"current":"feature","local":[{"name":"main"},{"name":"feature"}]}}"#, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(
            session: try session(id: "s1"),
            server: URL(string: "https://example.test")!,
            apiClient: client
        )

        await viewModel.load()
        XCTAssertEqual(viewModel.branches?.local?.compactMap(\.name), ["main", "feature"])

        let outcome = await viewModel.checkout(GitCheckoutTarget(ref: "feature", mode: .local))

        XCTAssertEqual(outcome, .success)
        XCTAssertEqual(viewModel.currentBranchName, "feature")
        XCTAssertEqual(viewModel.status?.branch, "feature")
    }

    @MainActor
    func testCheckoutDirtyWorktreeRequestsStashConfirmation() async throws {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main"}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main"}}"#, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main"}}"#, for: request)
            case "/api/git/checkout":
                let response = HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error":"Checkout blocked","code":"dirty_worktree"}"#.utf8))
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(
            session: try session(id: "s1"),
            server: URL(string: "https://example.test")!,
            apiClient: client
        )
        await viewModel.load()

        let outcome = await viewModel.checkout(GitCheckoutTarget(ref: "feature", mode: .local))

        XCTAssertEqual(outcome, .requiresStash)
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    @MainActor
    func testStashCheckoutSurfacesRestoreFailureOnSuccess() async throws {
        var currentBranch = "main"
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"\#(currentBranch)"}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"\#(currentBranch)"}}"#, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"\#(currentBranch)","local":[{"name":"main"},{"name":"feature"}]}}"#, for: request)
            case "/api/git/stash-checkout":
                currentBranch = "feature"
                return apiTestJSONResponse(#"{"ok":true,"current_branch":"feature","status":{"is_git":true,"branch":"feature"},"branches":{"is_git":true,"current":"feature","local":[{"name":"main"},{"name":"feature"}]},"restore_failed":true,"restore_error":"CONFLICT: stash could not be restored"}"#, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(
            session: try session(id: "s1"),
            server: URL(string: "https://example.test")!,
            apiClient: client
        )
        await viewModel.load()

        let outcome = await viewModel.checkout(
            GitCheckoutTarget(ref: "feature", mode: .local),
            stashingChanges: true
        )

        // The branch switch itself succeeded, so the outcome stays .success...
        XCTAssertEqual(outcome, .success)
        XCTAssertEqual(viewModel.currentBranchName, "feature")
        // ...but the restore failure must surface so the UI can alert the user that
        // their stashed changes were not re-applied.
        XCTAssertEqual(viewModel.actionErrorMessage, "CONFLICT: stash could not be restored")
    }

    @MainActor
    func testCheckoutSemanticFailurePreservesBranchStateAndSkipsRefresh() async throws {
        var calls: [String] = []
        let client = makeClient { request in
            let path = request.url?.path ?? ""
            calls.append(path)
            switch path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main"}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main"}}"#, for: request)
            case "/api/git/checkout":
                return apiTestJSONResponse(#"{"ok":false,"message":"Checkout rejected","status":{"is_git":true,"branch":"feature"},"branches":{"is_git":true,"current":"feature"}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(
            session: try session(id: "s1"),
            server: URL(string: "https://example.test")!,
            apiClient: client
        )
        await viewModel.load()
        calls.removeAll()

        let outcome = await viewModel.checkout(GitCheckoutTarget(ref: "feature", mode: .local))

        XCTAssertEqual(outcome, .failure)
        XCTAssertEqual(calls, ["/api/git/checkout"])
        XCTAssertEqual(viewModel.currentBranchName, "main")
        XCTAssertEqual(viewModel.status?.branch, "main")
        XCTAssertEqual(viewModel.actionErrorMessage, "Checkout rejected")
    }

    @MainActor
    func testRemotePushSemanticFailurePreservesStateAndSkipsRefresh() async throws {
        var calls: [String] = []
        let client = makeClient { request in
            let path = request.url?.path ?? ""
            calls.append(path)
            switch path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main"}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(Self.statusWithOneFile, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main"}}"#, for: request)
            case "/api/git/push":
                return apiTestJSONResponse(#"{"ok":false,"message":"Push rejected","status":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let viewModel = GitWorkspaceAvailabilityViewModel(
            session: try session(id: "s1"),
            server: URL(string: "https://example.test")!,
            apiClient: client
        )
        await viewModel.load()
        calls.removeAll()

        let succeeded = await viewModel.performRemoteAction(.push)

        XCTAssertFalse(succeeded)
        XCTAssertEqual(calls, ["/api/git/push"])
        XCTAssertEqual(viewModel.status?.branch, "main")
        XCTAssertNil(viewModel.lastActionMessage)
        XCTAssertEqual(viewModel.actionErrorMessage, "Push rejected")
    }

    func testWriteAvailabilityDisablesWritesDuringStreamAndCachedMode() {
        XCTAssertFalse(GitWriteAvailability(isStreaming: false, isViewingCachedData: false).writesDisabled)
        XCTAssertTrue(GitWriteAvailability(isStreaming: true, isViewingCachedData: false).writesDisabled)
        XCTAssertTrue(GitWriteAvailability(isStreaming: false, isViewingCachedData: true).writesDisabled)
        XCTAssertFalse(GitWriteAvailability(isStreaming: true, isViewingCachedData: false).fetchDisabled)
        XCTAssertTrue(GitWriteAvailability(isStreaming: false, isViewingCachedData: true).fetchDisabled)
    }

    /// TAL-140: the Git Actions setting hides the turn-end surfaces (inline commit button,
    /// "File changes" recap) the same way it already hides the toolbar menu and branch picker.
    func testTurnGitSurfaceVisibilityRequiresSettingAndTurnConditions() {
        func visibility(
            settingEnabled: Bool = true,
            hasRepository: Bool = true,
            isStreaming: Bool = false,
            latestMessageRole: String? = "assistant"
        ) -> ChatTurnGitSurfaceVisibility {
            ChatTurnGitSurfaceVisibility(
                settingEnabled: settingEnabled,
                hasRepository: hasRepository,
                isStreaming: isStreaming,
                latestMessageRole: latestMessageRole
            )
        }

        XCTAssertTrue(visibility().isVisible)
        XCTAssertFalse(visibility(settingEnabled: false).isVisible)
        XCTAssertFalse(visibility(hasRepository: false).isVisible)
        XCTAssertFalse(visibility(isStreaming: true).isVisible)
        XCTAssertFalse(visibility(latestMessageRole: "user").isVisible)
        XCTAssertFalse(visibility(latestMessageRole: nil).isVisible)
    }

    // MARK: - Diff hunks (TAL-604)

    private func hunks(_ json: String, diff: String = "") throws -> [DiffHunk] {
        DiffHunk.resolved(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)), diff: diff)
    }

    func testServerHunksDecodeNumberedWithTheirLabels() throws {
        let decoded = try hunks("""
        [{"header": "@@ -1,2 +1,2 @@", "old_start": 1, "new_start": 1, "new_end": 2, "additions": 1, "deletions": 1, "lines": [
          {"kind": "deletion", "old_line": 1, "new_line": null, "text": "-a"},
          {"kind": "addition", "old_line": null, "new_line": 1, "text": "+b"},
          {"kind": "context", "old_line": 2, "new_line": 2, "text": " c"}]},
         {"header": "@@ -9,1 +9,0 @@", "old_start": 9, "new_start": 9, "new_end": 9, "additions": 0, "deletions": 1, "lines": [
          {"kind": "deletion", "old_line": 9, "new_line": null, "text": "-z"}]},
         {"header": "", "old_start": null, "new_start": null, "new_end": null, "additions": 1, "deletions": 0, "lines": [
          {"kind": "addition", "old_line": null, "new_line": null, "text": "+x"}]}]
        """, diff: "ignored when the server sends hunks")

        XCTAssertEqual(decoded.map(\.id), [0, 1, 2])
        XCTAssertEqual(decoded.map(\.displayLabel), ["Lines 1-2", "Line 9", "Patch 3 of 3"])
        XCTAssertEqual(decoded.map(\.additions), [1, 0, 1])
        XCTAssertEqual(decoded[0].lines.map(\.kind), [.deletion, .addition, .context])
        XCTAssertEqual(decoded[0].lines.map(\.id), [0, 1, 2])
        XCTAssertEqual(decoded[0].lines.map(\.gutterLabel), ["1", "1", "2"])
        XCTAssertEqual(try hunks("[]", diff: "@@ -1 +1 @@\n-a\n+b"), [], "An empty server list is no change, never re-parsed.")
    }

    // Old-server fallback (TAL-697): a Web from before TAL-604 sends no hunks, so the App parses the diff.

    func testDiffParserDropsPreambleAndClassifiesLines() {
        let raw = """
        diff --git a/App.swift b/App.swift
        index 1234567..89abcde 100644
        --- a/App.swift
        +++ b/App.swift
        @@ -1,3 +1,3 @@
         context line
        -removed line
        +added line
        """
        let hunks = DiffHunk.resolved(nil, diff: raw)

        XCTAssertEqual(hunks.count, 1)
        let hunk = try! XCTUnwrap(hunks.first)
        XCTAssertEqual(hunk.header, "@@ -1,3 +1,3 @@")
        XCTAssertEqual(hunk.lines.count, 3)
        XCTAssertEqual(hunk.lines[0].kind, .context)
        XCTAssertEqual(hunk.lines[1].kind, .deletion)
        XCTAssertEqual(hunk.lines[2].kind, .addition)
        XCTAssertEqual(hunk.lines[2].text, "+added line")
    }

    func testDiffParserHandlesMultipleHunks() {
        let raw = """
        @@ -1,1 +1,1 @@
        -a
        +b
        @@ -10,2 +10,3 @@
         keep
        +new
        """
        let hunks = DiffHunk.resolved(nil, diff: raw)

        XCTAssertEqual(hunks.count, 2)
        XCTAssertEqual(hunks[0].id, 0)
        XCTAssertEqual(hunks[1].id, 1)
        XCTAssertEqual(hunks[1].header, "@@ -10,2 +10,3 @@")
        XCTAssertEqual(hunks[1].lines.map(\.kind), [.context, .addition])
        XCTAssertEqual(hunks[1].displayLabel, "Lines 10-12")
        XCTAssertEqual(hunks[1].lines[0].newLineNumber, 10)
        XCTAssertEqual(hunks[1].lines[1].newLineNumber, 11)
    }

    func testDiffParserKeepsTheNextFilesHeaderOutOfAMultiFileDiff() {
        // The Agent's multi-file patch result joins each file's diff with a blank line (TAL-448).
        let raw = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n\n--- a/b.txt\n+++ b/b.txt\n@@ -0,0 +1 @@\n+added\n"
        let hunks = DiffHunk.resolved(nil, diff: raw)

        XCTAssertEqual(hunks.map(\.additions), [1, 1])
        XCTAssertEqual(hunks.map(\.deletions), [1, 0])
        XCTAssertEqual(hunks[0].lines.map(\.text), ["-old", "+new"])
    }

    func testDiffParserCreatesSyntheticPatchWithoutHunkHeader() {
        let hunks = DiffHunk.resolved(nil, diff: "--- a/a.txt\n+++ b/a.txt\n-old\n+new")

        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].displayLabel, "Patch 1 of 1")
        XCTAssertEqual(hunks[0].additions, 1)
        XCTAssertEqual(hunks[0].deletions, 1)
    }

    func testSyntheticDiffParserKeepsChangedLinesBeginningWithHeaderLikePrefixes() {
        let hunks = DiffHunk.resolved(nil, diff: "--- a/a.txt\n+++ b/a.txt\n---actual content\n+++actual content")

        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].lines.map(\.text), ["---actual content", "+++actual content"])
        XCTAssertEqual(hunks[0].lines.map(\.kind), [.deletion, .addition])
    }

    func testDiffParserNumbersMultipleSyntheticPatches() {
        let hunks = DiffHunk.resolved(nil, diff: "diff --git a/a b/a\n-a\n+b\ndiff --git a/b b/b\n-c\n+d")

        XCTAssertEqual(hunks.map(\.displayLabel), ["Patch 1 of 2", "Patch 2 of 2"])
    }

    func testDiffParserEmptyInputReturnsNoHunks() {
        XCTAssertTrue(DiffHunk.resolved(nil, diff: "").isEmpty)
        XCTAssertTrue(DiffHunk.resolved(nil, diff: "diff --git a/x b/x\nindex 1..2\n").isEmpty, "No hunk header → nothing to show.")
    }

    @MainActor
    func testToastProgressSuccessAndAutoDismiss() async {
        let state = GitActionToastState()
        state.showProgress(GitActionProgress(title: "Working", detailLines: ["• Fetching"]))
        XCTAssertNotNil(state.progress)
        XCTAssertNil(state.success)

        state.showSuccess(GitActionSuccess(title: "Done"), autoDismissAfter: .milliseconds(10))
        XCTAssertNil(state.progress)
        XCTAssertNotNil(state.success)

        // Wait for the dismissal rather than a fixed 30 ms that a starved main actor can outlast.
        let deadline = ContinuousClock.now + .seconds(10)
        while state.success != nil, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNil(state.success)
    }

    @MainActor
    func testToastRapidReplacementDoesNotDismissLatestSuccess() async {
        let state = GitActionToastState()
        state.showSuccess(GitActionSuccess(title: "First"), autoDismissAfter: .milliseconds(5))
        // The replacement never expires on its own, so only the replaced 5 ms timer could dismiss it here.
        state.showSuccess(GitActionSuccess(title: "Second"), autoDismissAfter: .seconds(3600))

        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(state.success?.title, "Second")
        state.dismissSuccess()
    }

    // MARK: - Quick commit pipeline (issue #315, Slice C)

    /// Status with a single committable file, used to seed the availability/commit VMs.
    private static let statusWithOneFile = """
    {"git":{"is_git":true,"branch":"main","totals":{"changed":1},"files":[
      {"path":"a.swift","status":"M","unstaged":true,"additions":3,"deletions":1}
    ]}}
    """

    /// Status flagged `truncated` (server capped the list at 500 changed files). Reports a
    /// non-empty list so `hasCommittableChanges` is true and only the truncation blocks the commit.
    private static let truncatedStatus = """
    {"git":{"is_git":true,"branch":"main","totals":{"changed":501},"truncated":true,"files":[
      {"path":"a.swift","status":"M","unstaged":true,"additions":3,"deletions":1}
    ]}}
    """

    private func commitPipelineClient(
        stageStatus: Int = 200,
        pushStatus: Int = 200,
        semanticFailurePath: String? = nil,
        truncated: Bool = false,
        record: ((String) -> Void)? = nil
    ) -> APIClient {
        makeClient { request in
            let path = request.url?.path ?? ""
            record?(path)
            switch path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main","dirty":1}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(truncated ? Self.truncatedStatus : Self.statusWithOneFile, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main","local":[],"remote":[]}}"#, for: request)
            case "/api/git/stage":
                if stageStatus != 200 {
                    let response = HTTPURLResponse(url: request.url!, statusCode: stageStatus, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
                    return (response, Data(#"{"error":"Destructive git writes are disabled","code":"destructive_git_disabled"}"#.utf8))
                }
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"git":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"git":{"is_git":true,"branch":"main","totals":{"staged":1}}}"#, for: request)
            case "/api/git/commit-message":
                return apiTestJSONResponse(#"{"ok":true,"message":"Generated message","truncated":false}"#, for: request)
            case "/api/git/commit":
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Commit rejected","status":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"commit":"abc1234","status":{"is_git":true,"branch":"main","totals":{"changed":0},"files":[]}}"#, for: request)
            case "/api/git/push":
                if pushStatus != 200 {
                    let response = HTTPURLResponse(url: request.url!, statusCode: pushStatus, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
                    return (response, Data(#"{"error":"Remote rejected the push","code":"push_failed"}"#.utf8))
                }
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Push rejected","status":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"message":"pushed","status":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
    }

    @MainActor
    func testQuickCommitWithPushRunsFullPipelineAndReportsPhases() async throws {
        var phases: [GitCommitPhase] = []
        var paths: [String] = []
        let client = commitPipelineClient { paths.append($0) }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        XCTAssertTrue(vm.hasCommittableChanges)

        let outcome = await vm.quickCommit(push: true) { phases.append($0) }

        guard case .success(let result) = outcome else { return XCTFail("Expected success, got \(outcome)") }
        XCTAssertEqual(result.shortSHA, "abc1234")
        XCTAssertTrue(result.didPush)
        XCTAssertFalse(result.truncatedMessage)
        XCTAssertEqual(phases, [.generatingMessage, .committing, .pushing])
        XCTAssertNil(vm.commitPhase, "Phase resets after the pipeline finishes.")
        XCTAssertTrue(paths.contains("/api/git/stage"))
        XCTAssertTrue(paths.contains("/api/git/push"))
        XCTAssertEqual(vm.status?.changedCount, 0, "Status refreshes to the post-commit state.")
    }

    @MainActor
    func testQuickCommitWithoutPushSkipsPushCall() async throws {
        var paths: [String] = []
        let client = commitPipelineClient { paths.append($0) }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()

        let outcome = await vm.quickCommit(push: false)

        guard case .success(let result) = outcome else { return XCTFail("Expected success, got \(outcome)") }
        XCTAssertFalse(result.didPush)
        XCTAssertFalse(paths.contains("/api/git/push"), "push must not run for a plain Commit.")
    }

    @MainActor
    func testQuickCommitReportsSuccessWhenCommitSucceedsButPushFails() async throws {
        var paths: [String] = []
        let client = commitPipelineClient(pushStatus: 500) { paths.append($0) }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()

        let outcome = await vm.quickCommit(push: true)

        // The commit already landed, so a push failure must NOT collapse to .failure:
        // the SHA is reported, the push error is surfaced, and the badge/status refresh runs.
        guard case .success(let result) = outcome else { return XCTFail("Expected success, got \(outcome)") }
        XCTAssertEqual(result.shortSHA, "abc1234")
        XCTAssertFalse(result.didPush, "Push failed, so didPush stays false.")
        XCTAssertNotNil(result.pushFailureMessage, "The push failure is surfaced to the caller.")
        XCTAssertNotNil(vm.actionErrorMessage)
        XCTAssertNil(vm.commitPhase, "Phase resets even when push fails.")
        XCTAssertTrue(paths.contains("/api/git/push"), "push was attempted.")
        XCTAssertTrue(paths.filter { $0 == "/api/git-info" }.count >= 2, "refreshGitInfo runs after a push failure (load + post-commit).")
        XCTAssertEqual(vm.status?.changedCount, 0, "Status reflects the post-commit state.")
    }

    @MainActor
    func testQuickCommitReturnsNothingToCommitWhenClean() async throws {
        let client = makeClient { request in
            let path = request.url?.path ?? ""
            if path == "/api/git-info" { return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main"}}"#, for: request) }
            if path == "/api/git/branches" { return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main"}}"#, for: request) }
            return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main","files":[],"totals":{"changed":0}}}"#, for: request)
        }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()

        let outcome = await vm.quickCommit(push: true)
        XCTAssertEqual(outcome, .nothingToCommit)
        XCTAssertNil(vm.commitPhase)
    }

    @MainActor
    func testQuickCommitBlocksWhenStatusTruncated() async throws {
        // >500 changed files → server truncates the status list, so the client only knows the
        // first 500. Quick-commit must refuse (no stage/commit/push) instead of silently
        // committing a partial set. Both the plain Commit and Commit & Push rows are blocked.
        for push in [true, false] {
            var paths: [String] = []
            let client = commitPipelineClient(truncated: true) { paths.append($0) }
            let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
            await vm.load()
            XCTAssertEqual(vm.status?.truncated, true)
            XCTAssertTrue(vm.hasCommittableChanges)

            paths.removeAll()
            let outcome = await vm.quickCommit(push: push)

            XCTAssertEqual(outcome, .tooManyChanges, "push=\(push)")
            XCTAssertNil(vm.commitPhase, "Phase resets after the blocked commit (push=\(push)).")
            XCTAssertNotNil(vm.actionErrorMessage, "A blocked message is surfaced (push=\(push)).")
            XCTAssertFalse(paths.contains("/api/git/stage"), "No staging when truncated (push=\(push)).")
            XCTAssertFalse(paths.contains("/api/git/commit"), "No commit when truncated (push=\(push)).")
            XCTAssertFalse(paths.contains("/api/git/push"), "No push when truncated (push=\(push)).")
        }
    }

    @MainActor
    func testQuickCommitFailsWithFriendlyMessageWhenWritesDisabled() async throws {
        let client = commitPipelineClient(stageStatus: 403)
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()

        let outcome = await vm.quickCommit(push: true)
        XCTAssertEqual(outcome, .failure)
        XCTAssertNil(vm.commitPhase)
        XCTAssertEqual(vm.actionErrorMessage?.contains("Writes disabled"), true)
    }

    @MainActor
    func testQuickCommitStopsOnSemanticStageFailure() async throws {
        var paths: [String] = []
        let client = commitPipelineClient(semanticFailurePath: "/api/git/stage") { paths.append($0) }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        paths.removeAll()

        let outcome = await vm.quickCommit(push: true)

        XCTAssertEqual(outcome, .failure)
        XCTAssertEqual(paths, ["/api/git/stage"])
        XCTAssertEqual(vm.status?.branch, "main")
        XCTAssertEqual(vm.actionErrorMessage, "The server rejected the request.")
    }

    @MainActor
    func testQuickCommitStopsOnSemanticCommitFailure() async throws {
        var paths: [String] = []
        let client = commitPipelineClient(semanticFailurePath: "/api/git/commit") { paths.append($0) }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        paths.removeAll()

        let outcome = await vm.quickCommit(push: true)

        XCTAssertEqual(outcome, .failure)
        XCTAssertEqual(paths, ["/api/git/stage", "/api/git/commit-message", "/api/git/commit"])
        XCTAssertEqual(vm.status?.branch, "main")
        XCTAssertEqual(vm.actionErrorMessage, "Commit rejected")
    }

    @MainActor
    func testQuickCommitReportsSemanticPushFailureAsPartialSuccess() async throws {
        var paths: [String] = []
        let client = commitPipelineClient(semanticFailurePath: "/api/git/push") { paths.append($0) }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        paths.removeAll()

        let outcome = await vm.quickCommit(push: true)

        guard case .success(let result) = outcome else { return XCTFail("Expected partial success, got \(outcome)") }
        XCTAssertEqual(result.shortSHA, "abc1234")
        XCTAssertFalse(result.didPush)
        XCTAssertEqual(result.pushFailureMessage, "Push rejected")
        XCTAssertEqual(vm.actionErrorMessage, "Push rejected")
        XCTAssertEqual(paths, [
            "/api/git/stage", "/api/git/commit-message", "/api/git/commit",
            "/api/git/push", "/api/git/branches", "/api/git-info",
        ])
    }

    @MainActor
    func testRefreshAfterExternalMutationPicksUpNewStatus() async throws {
        var changed = true
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/git-info":
                return apiTestJSONResponse(#"{"git":{"is_git":true,"branch":"main"}}"#, for: request)
            case "/api/git/branches":
                return apiTestJSONResponse(#"{"branches":{"is_git":true,"current":"main"}}"#, for: request)
            default:
                let json = changed ? Self.statusWithOneFile : #"{"git":{"is_git":true,"branch":"main","files":[],"totals":{"changed":0}}}"#
                return apiTestJSONResponse(json, for: request)
            }
        }
        let vm = GitWorkspaceAvailabilityViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        XCTAssertEqual(vm.status?.changedCount, 1)

        changed = false
        await vm.refreshAfterExternalMutation()

        XCTAssertEqual(vm.status?.changedCount, 0, "Refreshing after an agent turn surfaces the new working-tree state.")
    }

    // MARK: - Advanced staging sheet view model (GitCommitViewModel)

    private func commitSheetClient(
        suggestSelectedMessage: String = "selected msg",
        discardStatus: Int = 200,
        pushStatus: Int = 200,
        semanticFailurePath: String? = nil,
        record: ((String) -> Void)? = nil
    ) -> APIClient {
        makeClient { request in
            let path = request.url?.path ?? ""
            record?(path)
            switch path {
            case "/api/git/push":
                if pushStatus != 200 {
                    let response = HTTPURLResponse(url: request.url!, statusCode: pushStatus, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
                    return (response, Data(#"{"error":"Remote rejected the push","code":"push_failed"}"#.utf8))
                }
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Push rejected","status":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"message":"pushed","status":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            case "/api/git/status":
                return apiTestJSONResponse(Self.statusWithOneFile, for: request)
            case "/api/git/commit-message":
                return apiTestJSONResponse(#"{"ok":true,"message":"Generated message","truncated":true}"#, for: request)
            case "/api/git/commit-message-selected":
                return apiTestJSONResponse(#"{"ok":true,"message":"\#(suggestSelectedMessage)","truncated":false}"#, for: request)
            case "/api/git/commit":
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Commit rejected","status":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"commit":"abc1234","status":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            case "/api/git/commit-selected":
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Commit rejected","status":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"commit":"deadbee","paths":["a.swift"],"status":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            case "/api/git/stage", "/api/git/unstage":
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Mutation rejected","git":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"git":{"is_git":true,"branch":"main"}}"#, for: request)
            case "/api/git/discard":
                if discardStatus != 200 {
                    let response = HTTPURLResponse(url: request.url!, statusCode: discardStatus, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
                    return (response, Data(#"{"error":"Destructive git writes are disabled","code":"destructive_git_disabled"}"#.utf8))
                }
                if semanticFailurePath == path {
                    return apiTestJSONResponse(#"{"ok":false,"message":"Mutation rejected","git":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok":true,"git":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
    }

    @MainActor
    func testCommitSheetSuggestMessagePopulatesFieldWithoutSelection() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient())
        await vm.load()
        XCTAssertTrue(vm.message.isEmpty)

        await vm.suggestMessage()

        XCTAssertEqual(vm.message, "Generated message")
        XCTAssertTrue(vm.messageWasTruncated, "The large-diff flag is surfaced.")
    }

    @MainActor
    func testCommitSheetSuggestUsesSelectedEndpointWhenFilesSelected() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient())
        await vm.load()
        let file = try XCTUnwrap(vm.trackedFiles.first)
        vm.toggleSelection(file)
        XCTAssertTrue(vm.hasSelection)

        await vm.suggestMessage()

        XCTAssertEqual(vm.message, "selected msg")
        XCTAssertFalse(vm.messageWasTruncated)
    }

    @MainActor
    func testCommitSheetCommitClearsMessageAndBumpsRevision() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient())
        await vm.load()
        vm.message = "Real commit"

        let ok = await vm.commit(push: false)

        XCTAssertTrue(ok)
        XCTAssertEqual(vm.lastCommitSHA, "abc1234")
        XCTAssertEqual(vm.committedRevision, 1)
        XCTAssertTrue(vm.message.isEmpty, "The message field clears after a successful commit.")
    }

    @MainActor
    func testCommitSheetCommitSucceedsAndClearsStateEvenWhenPushFails() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient(pushStatus: 500))
        await vm.load()
        vm.message = "Real commit"

        let ok = await vm.commit(push: true)

        // Commit landed; a push failure must still run the success cleanup so the caller
        // (GitCommitView) calls onCommitted() and the toolbar refreshes — while the sheet
        // banner reports that only the push failed.
        XCTAssertTrue(ok, "A push failure after a successful commit still returns true.")
        XCTAssertEqual(vm.lastCommitSHA, "abc1234")
        XCTAssertEqual(vm.committedRevision, 1, "committedRevision still bumps so the toolbar refreshes.")
        XCTAssertTrue(vm.message.isEmpty, "The message field clears after the commit lands.")
        let banner = try XCTUnwrap(vm.actionErrorMessage, "The push failure is surfaced in the sheet banner.")
        XCTAssertTrue(banner.contains("push failed"), "The banner reads as a partial success, not a failed commit.")
        XCTAssertTrue(banner.contains("Remote rejected the push"), "The server's push error detail is preserved.")
    }

    @MainActor
    func testCommitSheetCommitRequiresNonEmptyMessage() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient())
        await vm.load()

        let ok = await vm.commit(push: false)

        XCTAssertFalse(ok)
        XCTAssertEqual(vm.committedRevision, 0)
        XCTAssertNotNil(vm.actionErrorMessage)
    }

    @MainActor
    func testCommitSheetCommitSelectedCommitsChosenPaths() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient())
        await vm.load()
        let file = try XCTUnwrap(vm.trackedFiles.first)
        vm.toggleSelection(file)
        vm.message = "Partial"

        let ok = await vm.commitSelected(push: false)

        XCTAssertTrue(ok)
        XCTAssertEqual(vm.lastCommitSHA, "deadbee")
        XCTAssertFalse(vm.hasSelection, "Selection clears after committing it.")
    }

    @MainActor
    func testCommitSheetSemanticCommitFailuresPreserveInputAndSelection() async throws {
        for selected in [false, true] {
            let path = selected ? "/api/git/commit-selected" : "/api/git/commit"
            var calls: [String] = []
            let vm = GitCommitViewModel(
                session: try session(id: "s1"),
                server: URL(string: "https://example.test")!,
                apiClient: commitSheetClient(semanticFailurePath: path) { calls.append($0) }
            )
            await vm.load()
            calls.removeAll()
            if selected { vm.toggleSelection(try XCTUnwrap(vm.trackedFiles.first)) }
            vm.message = "Keep me"

            let succeeded = selected ? await vm.commitSelected(push: false) : await vm.commit(push: false)

            XCTAssertFalse(succeeded, "path=\(path)")
            XCTAssertEqual(vm.message, "Keep me", "path=\(path)")
            XCTAssertEqual(vm.hasSelection, selected, "path=\(path)")
            XCTAssertEqual(vm.status?.branch, "main", "path=\(path)")
            XCTAssertEqual(vm.committedRevision, 0, "path=\(path)")
            XCTAssertEqual(vm.actionErrorMessage, "Commit rejected", "path=\(path)")
            XCTAssertEqual(calls, [path])
        }
    }

    @MainActor
    func testCommitSheetSemanticMutationFailuresPreserveStatusAndSelection() async throws {
        for path in ["/api/git/stage", "/api/git/unstage", "/api/git/discard"] {
            var calls: [String] = []
            let vm = GitCommitViewModel(
                session: try session(id: "s1"),
                server: URL(string: "https://example.test")!,
                apiClient: commitSheetClient(semanticFailurePath: path) { calls.append($0) }
            )
            await vm.load()
            calls.removeAll()
            vm.toggleSelection(try XCTUnwrap(vm.trackedFiles.first))

            switch path {
            case "/api/git/stage": await vm.stageSelectedOrAll()
            case "/api/git/unstage": await vm.unstageSelectedOrAll()
            default: await vm.discardSelectedOrAll(deleteUntracked: false)
            }

            XCTAssertEqual(vm.status?.branch, "main", "path=\(path)")
            XCTAssertEqual(vm.trackedFiles.count, 1, "path=\(path)")
            XCTAssertTrue(vm.hasSelection, "path=\(path)")
            XCTAssertEqual(vm.actionErrorMessage, "Mutation rejected", "path=\(path)")
            XCTAssertEqual(calls, [path])
        }
    }

    @MainActor
    func testDiscardStopsWhenSemanticUnstageFails() async throws {
        var calls: [String] = []
        let stagedStatus = """
        {"git":{"is_git":true,"branch":"main","totals":{"changed":1},"files":[
          {"path":"a.swift","status":"M","staged":true,"additions":3,"deletions":1}
        ]}}
        """
        let client = makeClient { request in
            let path = request.url?.path ?? ""
            calls.append(path)
            switch path {
            case "/api/git/status":
                return apiTestJSONResponse(stagedStatus, for: request)
            case "/api/git/unstage":
                return apiTestJSONResponse(#"{"ok":false,"message":"Unstage rejected","git":{"is_git":true,"branch":"other","files":[]}}"#, for: request)
            case "/api/git/discard":
                return apiTestJSONResponse(#"{"ok":true,"git":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        calls.removeAll()

        await vm.discardSelectedOrAll(deleteUntracked: false)

        XCTAssertEqual(calls, ["/api/git/unstage"])
        XCTAssertEqual(vm.trackedFiles.count, 1)
        XCTAssertEqual(vm.actionErrorMessage, "Unstage rejected")
    }

    @MainActor
    func testCommitSheetSemanticPushFailureRemainsPartialSuccess() async throws {
        var calls: [String] = []
        let vm = GitCommitViewModel(
            session: try session(id: "s1"),
            server: URL(string: "https://example.test")!,
            apiClient: commitSheetClient(semanticFailurePath: "/api/git/push") { calls.append($0) }
        )
        await vm.load()
        calls.removeAll()
        vm.message = "Real commit"

        let succeeded = await vm.commit(push: true)

        XCTAssertTrue(succeeded)
        XCTAssertEqual(vm.lastCommitSHA, "abc1234")
        XCTAssertTrue(vm.message.isEmpty)
        XCTAssertEqual(vm.committedRevision, 1)
        XCTAssertEqual(vm.status?.branch, "main")
        XCTAssertEqual(vm.actionErrorMessage, "Committed, but the push failed. Push rejected")
        XCTAssertEqual(calls, ["/api/git/commit", "/api/git/push"])
    }

    @MainActor
    func testCommitSheetDiscardSurfacesFriendlyErrorWhenDisabled() async throws {
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: commitSheetClient(discardStatus: 403))
        await vm.load()

        await vm.discardSelectedOrAll(deleteUntracked: false)

        XCTAssertEqual(vm.actionErrorMessage?.contains("Writes disabled"), true)
    }

    @MainActor
    func testCommitSheetDiscardUnstagesStagedFilesFirst() async throws {
        // The server's discard only restores the worktree, leaving the index intact, so a
        // staged change would survive. The sheet must unstage staged targets before
        // discarding (and in that order) for the discard to actually take effect.
        var calls: [String] = []
        let stagedStatus = """
        {"git":{"is_git":true,"branch":"main","totals":{"changed":1},"files":[
          {"path":"a.swift","status":"M","staged":true,"additions":3,"deletions":1}
        ]}}
        """
        let client = makeClient { request in
            let path = request.url?.path ?? ""
            switch path {
            case "/api/git/status":
                return apiTestJSONResponse(stagedStatus, for: request)
            case "/api/git/unstage", "/api/git/discard":
                calls.append(path)
                return apiTestJSONResponse(#"{"ok":true,"git":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        XCTAssertEqual(vm.trackedFiles.first?.staged, true)

        await vm.discardSelectedOrAll(deleteUntracked: false)

        XCTAssertNil(vm.actionErrorMessage)
        XCTAssertEqual(calls, ["/api/git/unstage", "/api/git/discard"],
                       "Staged targets are unstaged before discard so the index is reverted too.")
    }

    @MainActor
    func testCommitSheetDiscardSkipsUnstageWhenNoStagedTargets() async throws {
        // A purely unstaged change needs no unstage step — discard alone reverts the worktree.
        var calls: [String] = []
        let client = makeClient { request in
            let path = request.url?.path ?? ""
            switch path {
            case "/api/git/status":
                return apiTestJSONResponse(Self.statusWithOneFile, for: request)
            case "/api/git/unstage", "/api/git/discard":
                calls.append(path)
                return apiTestJSONResponse(#"{"ok":true,"git":{"is_git":true,"branch":"main","files":[]}}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
        let vm = GitCommitViewModel(session: try session(id: "s1"), server: URL(string: "https://example.test")!, apiClient: client)
        await vm.load()
        XCTAssertEqual(vm.trackedFiles.first?.unstaged, true)

        await vm.discardSelectedOrAll(deleteUntracked: false)

        XCTAssertEqual(calls, ["/api/git/discard"], "No staged targets means no unstage call.")
    }
}
