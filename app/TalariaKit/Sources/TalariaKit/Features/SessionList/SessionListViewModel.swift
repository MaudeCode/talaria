import Foundation
import Observation
import SwiftData
import SwiftUI

public struct ScheduledSessionGroups: Equatable {
    public let ordinary: [SessionSummary]
    public let scheduled: [SessionSummary]
    public let webhook: [SessionSummary]
    public let totalScheduledCount: Int
    public let totalWebhookCount: Int
    /// More scheduled / webhook sessions exist than the server lists (TAL-482).
    public var scheduledCountIsPartial = false
    public var webhookCountIsPartial = false

    var scheduledPreview: [SessionSummary] {
        Array(scheduled.prefix(5))
    }

    var hasAdditionalScheduledSessions: Bool {
        scheduled.count > scheduledPreview.count
    }

    var webhookPreview: [SessionSummary] {
        Array(webhook.prefix(5))
    }

    var hasAdditionalWebhookSessions: Bool {
        webhook.count > webhookPreview.count
    }

    public func showsDisclosure(isSearchActive: Bool) -> Bool {
        totalScheduledCount > 0 && (!isSearchActive || !scheduled.isEmpty)
    }

    public func showsWebhookDisclosure(isSearchActive: Bool) -> Bool {
        totalWebhookCount > 0 && (!isSearchActive || !webhook.isEmpty)
    }
}

public enum ActiveSessionStateRefreshResult: Equatable {
    case unchanged
    case reloaded
    case failed
}

@MainActor
@Observable
public final class SessionListViewModel {
    public private(set) var sessions: [SessionSummary] = []
    public private(set) var isLoading = false
    public private(set) var isCreatingSession = false
    public private(set) var isCreatingProject = false
    public private(set) var isLoadingProjects = false
    public private(set) var isDeletingProject = false
    public private(set) var isRenamingSession = false
    public private(set) var isRenamingProject = false
    public private(set) var isMovingSession = false
    public private(set) var isViewingCachedData = false
    public private(set) var projects: [ProjectSummary] = []
    public private(set) var errorMessage: String?
    public private(set) var actionErrorMessage: String?
    private(set) var cacheErrorMessage: String?
    private(set) var searchErrorMessage: String?
    public private(set) var isSearchingRemoteSessions = false
    public private(set) var sessionLoadError: Error?
    public private(set) var lastError: Error?
    public private(set) var activeProfileName: String?
    public private(set) var activeProfileDisplayName: String?
    private(set) var activeProfileModel: String?
    private(set) var activeProfileProvider: String?
    public private(set) var profileOptions: [ProfileSummary] = []
    public private(set) var isSingleProfileMode = false
    public private(set) var isLoadingActiveProfile = false
    public private(set) var isSwitchingActiveProfile = false
    private(set) var switchingActiveProfileName: String?
    private(set) var activeProfileErrorMessage: String?
    private(set) var mutatingSessionIDs: Set<String> = []
    /// Total archived sessions reported by the last successful list load
    /// (`archived_count`, issue #17). nil until a load succeeds or when an older
    /// server omits the field — the Archived entry stays hidden then.
    public private(set) var archivedCount: Int?
    /// Server totals for the automated-session groups from the last successful list
    /// load (TAL-482). nil until then or from an older server; the groups then count
    /// the loaded rows instead.
    public private(set) var automatedSessionCounts: AutomatedSessionCounts?
    /// The latest archive the Chats list still offers to undo (TAL-443). A second
    /// archive replaces it, so only the latest one is undoable.
    public private(set) var archiveUndo: SessionArchiveUndo?
    private var archiveUndoTask: Task<Void, Never>?
    private var archiveUndoOffers = 0

    /// The server's complete, ordered result for `activeRemoteSearch` (TAL-308);
    /// nil until it arrives, while the list shows local title matches.
    private(set) var remoteSearchResults: [SessionSummary]?
    /// Whether the server applied the project and visibility filters itself
    /// (`sidebar_filtered`). Old-server fallback: delete once every supported
    /// server ships the field.
    private var remoteSearchIsFiltered = false
    /// Server-redacted excerpts for the content matches in `remoteSearchResults`,
    /// keyed by session ID. Set and cleared together with the results so an
    /// excerpt never outlives the query that produced it.
    private(set) var remoteContentSearchPreviews: [String: String] = [:]
    private var activeRemoteSearch: RemoteSearchScope?
    private var loadGeneration = 0
    /// Every full-list reload goes through here — the automatic tick,
    /// pull-to-refresh, the return refresh, the active-row monitor and the
    /// reloads below that follow a mutation — so exactly one owner serves them
    /// and no caller is left waiting on a reload nobody will run.
    private let refreshQueue = SessionListRefreshQueue()
    /// The profile reload gets its own queue for the same reason: a trigger
    /// arriving mid-request is coalesced into a follow-up instead of being
    /// dropped, since the request in flight may predate the change it reacts to.
    private let profileRefreshQueue = SessionListRefreshQueue()
    private var projectsGeneration = 0
    private var activeProfileGeneration = 0
    private var openGeneration = 0
    /// Counts local claims on list rows: a detail that refreshed an opened row, or a
    /// row the list inserted itself. A claim is stamped with the value at the moment
    /// it is made — not when its request began — so a list load that started while
    /// that request was still pending is treated as older.
    private var claimCount = 0
    /// Claimed rows, with the claim that made them, so a `/api/sessions` response
    /// that was already in flight cannot reinstate the stale metadata it captured
    /// or drop a row inserted after it was requested (TAL-176).
    private var claimedRows: [String: (session: SessionSummary, claim: Int, inserted: Bool)] = [:]

    private let client: APIClient
    private let sessionMutator: SessionMutator
    private let server: URL
    private let cacheGeneration: Int
    private let responseCache: ResponseCache?
    private let archiveUndoLifetime: Duration

    public init(
        server: URL,
        client: APIClient? = nil,
        responseCache: ResponseCache? = nil,
        archiveUndoLifetime: Duration = .seconds(5)
    ) {
        self.server = server
        self.archiveUndoLifetime = archiveUndoLifetime
        cacheGeneration = ServerCacheGeneration.current(for: server)
        self.responseCache = responseCache
        let resolvedClient = client ?? APIClient(baseURL: server)
        self.client = resolvedClient
        self.sessionMutator = SessionMutator(client: resolvedClient)

        // Sweep exports leaked by a previous app run (view dismissed while a
        // download was in flight, so the share sheet — and its on-dismiss
        // cleanup — never appeared). `State(initialValue:)` re-runs this init
        // on every parent redraw, so the sweep must be once-per-process (the
        // lazy static below), or it would delete a file an active share sheet
        // is presenting. The first-ever init always precedes the first export,
        // so the single sweep can never race an in-flight export.
        _ = Self.sweepLeakedExportsOnce
    }

    /// Root temp directory holding one UUID subdirectory per export
    /// (see `export(_:format:)`).
    nonisolated static var exportsRootDirectory: URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("session-exports", isDirectory: true)
    }

    /// Lazy static ⇒ runs exactly once per process, on first access.
    nonisolated private static let sweepLeakedExportsOnce: Void = {
        try? FileManager.default.removeItem(at: exportsRootDirectory)
    }()

    public func visibleSessions(
        searchText rawSearchText: String,
        selectedProjectID: String?,
        automatedVisibility: AutomatedSessionVisibility = .showAll
    ) -> [SessionSummary] {
        let query = Self.normalizedSearchQuery(rawSearchText)
        let baseSessions = sessions.filter { automatedVisibility.shows($0) }
        let projectFilteredSessions = baseSessions.filter { session in
            guard let selectedProjectID else { return true }
            return session.projectId == selectedProjectID
        }
        // The server's order is canonical (TAL-306); `inDisplayOrder` re-sorts only an older server's rows.
        guard !query.isEmpty else {
            return projectFilteredSessions.inDisplayOrder
        }

        let titleMatches: (SessionSummary) -> Bool = { $0.title?.lowercased().contains(query) == true }
        guard activeRemoteSearch == RemoteSearchScope(query: query, projectID: selectedProjectID),
              let remoteSearchResults
        else {
            return projectFilteredSessions.filter(titleMatches).inDisplayOrder
        }

        guard remoteSearchIsFiltered else {
            // Old-server fallback: that server ignores the filters, so keep only its hits this list shows.
            let remoteIDs = Set(remoteSearchResults.compactMap(\.sessionId))
            return projectFilteredSessions.filter { session in
                titleMatches(session) || (session.archived != true && session.sessionId.map(remoteIDs.contains) == true)
            }.inDisplayOrder
        }

        // The server's set and order (TAL-308), showing the loaded copy of a row so local edits stay current.
        let loadedByID = Dictionary(
            sessions.compactMap { session -> (String, SessionSummary)? in
                guard let sessionID = session.sessionId, !sessionID.isEmpty else { return nil }
                return (sessionID, session)
            },
            uniquingKeysWith: { first, _ in first }
        )
        return remoteSearchResults
            .map { result in result.sessionId.flatMap { loadedByID[$0] } ?? result }
            .filter { automatedVisibility.shows($0) }
    }

    /// The excerpt explaining why `session` is listed for `searchText`, or nil
    /// when the row is not a content match for the search currently applied —
    /// the same guard `visibleSessions` uses, so a query typed ahead of the
    /// remote search never shows the previous query's excerpt.
    public func contentMatchPreview(for session: SessionSummary, searchText rawSearchText: String) -> String? {
        let query = Self.normalizedSearchQuery(rawSearchText)
        guard !query.isEmpty, activeRemoteSearch?.query == query, let sessionID = session.sessionId else {
            return nil
        }

        return remoteContentSearchPreviews[sessionID]
    }

    public func scheduledSessionGroups(
        searchText: String,
        selectedProjectID: String?,
        automatedVisibility: AutomatedSessionVisibility = .showAll
    ) -> ScheduledSessionGroups {
        let candidates = visibleSessions(
            searchText: searchText,
            selectedProjectID: selectedProjectID,
            automatedVisibility: automatedVisibility
        )

        var groups = ScheduledSessionGroups(
            ordinary: candidates.filter { !$0.isCronSession && !$0.isWebhookSession },
            scheduled: candidates.filter {
                $0.isCronSession && !$0.isWebhookSession && $0.archived != true
            },
            webhook: candidates.filter { $0.isWebhookSession && $0.archived != true },
            totalScheduledCount: automatedVisibility.showsCron
                ? automatedSessionCounts?.scheduled
                    // Old-server fallback (TAL-482): delete once every supported server ships the counts.
                    ?? sessions.filter { $0.isCronSession && !$0.isWebhookSession && $0.archived != true }.count
                : 0,
            totalWebhookCount: automatedVisibility.showsWebhook
                ? automatedSessionCounts?.webhook
                    ?? sessions.filter { $0.isWebhookSession && $0.archived != true }.count
                : 0
        )
        groups.scheduledCountIsPartial = automatedSessionCounts?.scheduledIsPartial ?? false
        groups.webhookCountIsPartial = automatedSessionCounts?.webhookIsPartial ?? false
        return groups
    }

    /// Shows the last rows, projects and active profile this device saw on the first frame of a
    /// cold launch (TAL-437), so the list never starts empty; the next loads replace each with the
    /// server's. This is the expected-success window, so it stays out of offline mode.
    public func paintCachedStateIfEmpty(modelContext: ModelContext) {
        if sessions.isEmpty,
           let cachedSessions = try? CacheStore.cachedSessions(serverURL: server, in: modelContext)
            .filter(\.shouldAppearInSessionList),
           !cachedSessions.isEmpty {
            sessions = cachedSessions
            isShowingCachedPaint = true
        }
        if projects.isEmpty, let cachedProjects = responseCache?.entry(ResponseCache.Kind.projects).load(ProjectsResponse.self) {
            projects = cachedProjects.projects ?? []
        }
        if activeProfileName == nil, let cachedProfiles = responseCache?.entry(ResponseCache.Kind.profiles).load(ProfilesResponse.self) {
            applyActiveProfile(cachedProfiles)
        }
    }

    /// Whether the rows are the cached paint, not yet replaced by a server answer. A failed load
    /// that is not a connectivity failure clears them, as the chat reverts its own cached paint, so
    /// saved rows never pass for live ones without the offline banner.
    private var isShowingCachedPaint = false

    /// Runs already prefetched, as `session|stream`, so each run costs one request at most.
    private var prefetchedRuns: Set<String> = []

    /// Warms the transcript cache for running chats this device has never opened (TAL-437), one
    /// bounded page each, so opening a run started elsewhere paints at once.
    public func prefetchRunningTranscripts(modelContext: ModelContext) async {
        for session in sessions where session.isStreaming == true {
            guard let sessionID = Self.nonEmpty(session.sessionId) else { continue }
            let runKey = "\(sessionID)|\(session.activeStreamId ?? "")"
            guard !prefetchedRuns.contains(runKey) else { continue }
            prefetchedRuns.insert(runKey)
            // A chat opened here already has its own cache, which the chat keeps current. Checked
            // again after the request, in case the chat saved a newer transcript meanwhile.
            guard !hasCachedTranscript(sessionID, in: modelContext),
                  let messages = try? await client.session(
                    id: sessionID,
                    messageLimit: ChatViewModel.messagePageLimit,
                    expandRenderable: true
                  ).session?.messages,
                  !messages.isEmpty,
                  !hasCachedTranscript(sessionID, in: modelContext)
            else { continue }
            try? writeCacheIfCurrent {
                try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
            }
        }
    }

    /// Runs `write` only if no server-scoped reset ran since this list was created
    /// (`ServerCacheGeneration`), so a list still open on a previous identity cannot cache its rows.
    private func writeCacheIfCurrent(_ write: () throws -> Void) rethrows {
        guard ServerCacheGeneration.current(for: server) == cacheGeneration else { return }
        try write()
    }

    private func hasCachedTranscript(_ sessionID: String, in modelContext: ModelContext) -> Bool {
        let cached = try? CacheStore.cachedMessages(serverURL: server, sessionID: sessionID, in: modelContext, limit: 1)
        return !(cached?.isEmpty ?? true)
    }

    @discardableResult
    public func load(
        modelContext: ModelContext? = nil,
        animation: Animation? = nil
    ) async -> Bool {
        // A coalesced caller reports success for the same reason a superseded
        // one does below: a newer reload is authoritative for the list, and it
        // covers the request this caller just recorded.
        var didApply = true
        await refreshQueue.run {
            didApply = await self.performLoad(modelContext: modelContext, animation: animation)
        }
        return didApply
    }

    private func performLoad(
        modelContext: ModelContext?,
        animation: Animation?
    ) async -> Bool {
        loadGeneration += 1
        let generation = loadGeneration
        let claimCountAtStart = claimCount

        isLoading = true
        errorMessage = nil
        cacheErrorMessage = nil
        sessionLoadError = nil
        lastError = nil
        defer {
            if generation == loadGeneration {
                isLoading = false
            }
        }

        do {
            let response = try await client.sessions(visibility: .showAll)
            guard generation == loadGeneration else { return true }
            let visibleSessions = (response.sessions ?? [])
                .filter {
                    Self.nonEmpty($0.sessionId) != nil
                        && $0.archived != true
                        && $0.shouldAppearInSessionList
                }
            applySessions(
                visibleSessions,
                archivedCount: response.archivedCount,
                animation: animation,
                claimCountAtStart: claimCountAtStart
            )
            automatedSessionCounts = response.automatedSessionCounts
            isViewingCachedData = false
            isShowingCachedPaint = false

            if let modelContext {
                do {
                    // The applied rows, not the raw response: a stale list must not
                    // put stale metadata back into the cache the offline
                    // fallback reads.
                    try writeCacheIfCurrent { try CacheStore.cacheSessions(sessions, serverURL: server, in: modelContext) }
                } catch {
                    cacheErrorMessage = error.localizedDescription
                }
            }

            return true
        } catch {
            guard generation == loadGeneration else { return true }
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            sessionLoadError = error
            if isShowingCachedPaint {
                isShowingCachedPaint = false
                sessions = []
            }
            if CacheFallbackPolicy.shouldUseCache(for: error), let modelContext {
                do {
                    let cachedSessions = try CacheStore.cachedSessions(serverURL: server, in: modelContext)
                        .filter(\.shouldAppearInSessionList)
                    if !cachedSessions.isEmpty {
                        sessions = cachedSessions
                        isViewingCachedData = true
                        errorMessage = nil
                    } else {
                        isViewingCachedData = false
                        errorMessage = error.localizedDescription
                    }
                } catch {
                    cacheErrorMessage = error.localizedDescription
                    isViewingCachedData = false
                    errorMessage = lastError?.localizedDescription
                }
            } else {
                isViewingCachedData = false
                errorMessage = error.localizedDescription
            }

            return false
        }
    }

    public func loadActiveProfile() async {
        await profileRefreshQueue.run { await self.performLoadActiveProfile() }
    }

    private func performLoadActiveProfile() async {
        // Checked per queued reload rather than once on entry: a switch can begin
        // while a follow-up is still waiting its turn. A poll that starts after
        // `switchActiveProfile` bumped the fence but before its request lands
        // would capture the new generation and pass the guard below, restoring
        // the profile the user just left.
        guard !isSwitchingActiveProfile else { return }

        isLoadingActiveProfile = true
        activeProfileErrorMessage = nil
        defer { isLoadingActiveProfile = false }

        let generation = activeProfileGeneration
        do {
            let response = try await client.profiles(caching: responseCache?.entry(ResponseCache.Kind.profiles))
            // A switch the user made while this request was in flight is newer
            // than the profile it reports, so reapplying it would show the wrong
            // active profile and rebuild profile-dependent views for it.
            guard generation == activeProfileGeneration else { return }
            applyActiveProfile(response)
        } catch {
            guard !APIError.isCancellation(error) else { return }

            activeProfileErrorMessage = error.localizedDescription
        }
    }

    public func switchActiveProfile(_ profile: ProfileSummary) async -> Bool {
        guard !isViewingCachedData else {
            activeProfileErrorMessage = String(localized: "Reconnect to the server to change profiles.")
            return false
        }

        guard let profileName = Self.nonEmpty(profile.name) else {
            activeProfileErrorMessage = String(localized: "The server did not provide a profile name.")
            return false
        }

        guard profileName != activeProfileName else {
            return true
        }

        activeProfileGeneration += 1
        isSwitchingActiveProfile = true
        switchingActiveProfileName = profileName
        activeProfileErrorMessage = nil
        lastError = nil
        defer {
            isSwitchingActiveProfile = false
            switchingActiveProfileName = nil
        }

        do {
            let response = try await client.switchProfile(name: profileName)
            if let error = Self.nonEmpty(response.error) {
                activeProfileErrorMessage = error
                return false
            }

            let resolvedName = Self.nonEmpty(response.active) ?? profileName
            // The switch response has no `single_profile_mode` field; carry the
            // last known value forward so the switcher visibility doesn't flap.
            let profileResponse = ProfilesResponse(
                profiles: response.profiles ?? profileOptions,
                active: resolvedName,
                singleProfileMode: isSingleProfileMode
            )
            applyActiveProfile(
                profileResponse,
                fallbackProfile: profile,
                fallbackDefaultModel: response.defaultModel
            )
            return true
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            activeProfileErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Asks the server for the complete result within the selected project and
    /// visibility (TAL-308); `visibleSessions` shows it once it arrives.
    public func searchSessions(
        query rawQuery: String,
        selectedProjectID: String? = nil,
        automatedVisibility: AutomatedSessionVisibility = .showAll,
        content: Bool = true,
        depth: Int = 5,
        debounceNanoseconds: UInt64 = 350_000_000
    ) async {
        let query = Self.normalizedSearchQuery(rawQuery)
        let scope = RemoteSearchScope(query: query, projectID: selectedProjectID)
        activeRemoteSearch = scope
        remoteSearchResults = nil
        remoteContentSearchPreviews = [:]
        searchErrorMessage = nil

        guard !query.isEmpty, !isViewingCachedData else {
            isSearchingRemoteSessions = false
            return
        }

        do {
            if debounceNanoseconds > 0 {
                try await Task.sleep(nanoseconds: debounceNanoseconds)
            }

            guard !Task.isCancelled, activeRemoteSearch == scope else { return }

            isSearchingRemoteSessions = true
            let response = try await client.searchSessions(
                query: query,
                projectID: selectedProjectID,
                visibility: automatedVisibility,
                content: content,
                depth: depth
            )

            guard !Task.isCancelled, activeRemoteSearch == scope else { return }

            var seenSessionIDs = Set<String>()
            let results = (response.sessions ?? []).filter { result in
                guard let sessionID = result.sessionId, !sessionID.isEmpty else { return false }
                return seenSessionIDs.insert(sessionID).inserted
            }
            remoteSearchResults = results
            remoteSearchIsFiltered = response.sidebarFiltered == true
            remoteContentSearchPreviews = Dictionary(
                results.compactMap { result -> (String, String)? in
                    guard result.matchType?.lowercased() == "content",
                          let sessionID = result.sessionId,
                          let preview = Self.normalizedMatchPreview(result.matchPreview)
                    else { return nil }
                    return (sessionID, preview)
                },
                uniquingKeysWith: { first, _ in first }
            )
            isSearchingRemoteSessions = false
        } catch {
            guard activeRemoteSearch == scope else { return }

            isSearchingRemoteSessions = false
            guard !APIError.isCancellation(error) else { return }

            remoteSearchResults = nil
            remoteContentSearchPreviews = [:]
            searchErrorMessage = error.localizedDescription
            lastError = error
        }
    }

    func clearSearchResults() {
        activeRemoteSearch = nil
        remoteSearchResults = nil
        remoteContentSearchPreviews = [:]
        searchErrorMessage = nil
        isSearchingRemoteSessions = false
    }

    private var loadFailureRefreshResult: ActiveSessionStateRefreshResult {
        lastError == nil ? .unchanged : .failed
    }

    @discardableResult
    public func refreshActiveSessionStatesIfNeeded(
        streamIDs rawStreamIDs: [String],
        modelContext: ModelContext? = nil
    ) async -> ActiveSessionStateRefreshResult {
        guard !isViewingCachedData, !isLoading else { return .unchanged }

        let streamIDs = Self.normalizedStreamIDs(rawStreamIDs)
        guard !streamIDs.isEmpty else {
            return await load(modelContext: modelContext) ? .reloaded : loadFailureRefreshResult
        }

        for streamID in streamIDs {
            do {
                let response = try await client.chatStreamStatus(streamID: streamID)
                guard response.active == false else { continue }
                return await load(modelContext: modelContext) ? .reloaded : loadFailureRefreshResult
            } catch {
                guard !APIError.isCancellation(error) else { return .unchanged }
                if case APIError.unauthorized = error {
                    lastError = error
                    return .failed
                }
                continue
            }
        }

        return .unchanged
    }

    public func loadSessionForDeepLink(id rawSessionID: String, modelContext: ModelContext? = nil) async -> SessionSummary? {
        let sessionID = rawSessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionID.isEmpty else { return nil }

        if let loadedSession = sessions.first(where: { $0.sessionId == sessionID }) {
            return loadedSession
        }

        actionErrorMessage = nil
        lastError = nil

        if let modelContext {
            do {
                if let cachedSession = try CacheStore.cachedSessions(serverURL: server, in: modelContext)
                    .first(where: { $0.sessionId == sessionID }) {
                    return cachedSession
                }
            } catch {
                cacheErrorMessage = error.localizedDescription
            }
        }

        do {
            let response = try await client.session(id: sessionID, includeMessages: false, messageLimit: nil)
            guard let sessionDetail = response.session else {
                actionErrorMessage = String(localized: "The server did not return the linked session.")
                return nil
            }

            let session = SessionSummary(from: sessionDetail)
            if session.archived != true,
               session.shouldAppearInSessionList,
               !sessions.contains(where: { $0.sessionId == session.sessionId }) {
                claimRow(session, inserting: true)
            }

            if let modelContext, session.shouldAppearInSessionList {
                do {
                    try writeCacheIfCurrent { try CacheStore.cacheSession(session, serverURL: server, in: modelContext) }
                } catch {
                    cacheErrorMessage = error.localizedDescription
                }
            }

            return session
        } catch {
            lastError = error
            actionErrorMessage = error.localizedDescription
            return nil
        }
    }

    /// Resolves the session a tapped row should actually open.
    ///
    /// External rows (CLI/TUI bridges and messaging channels) reload their detail
    /// first: `GET /api/session` is the server's authority on whether the session is
    /// writable, and the server claims a CLI session on its first send. WebUI rows and
    /// cached (offline) browsing skip the request and open directly.
    ///
    /// Returns nil when the load failed — the caller stays on the list and the row is
    /// left in place — or when a later tap superseded this one.
    public func sessionToOpen(
        for session: SessionSummary,
        modelContext: ModelContext? = nil
    ) async -> SessionSummary? {
        openGeneration += 1
        let generation = openGeneration

        guard !isViewingCachedData,
              session.isExternalSourceSession,
              let sessionId = Self.nonEmpty(session.sessionId)
        else { return session }

        actionErrorMessage = nil
        lastError = nil

        do {
            guard let detail = try await client.session(
                id: sessionId,
                includeMessages: false,
                messageLimit: nil
            ).session else {
                throw APIError.http(statusCode: -1, body: nil)
            }
            guard generation == openGeneration else { return nil }

            // A list refresh can land while the load is in flight, so the merge base is
            // the current row rather than the pre-await snapshot — otherwise
            // `refreshRow` would roll the freshly loaded row back to stale list-only
            // metadata.
            let currentRow = sessions.first(where: { $0.sessionId == sessionId }) ?? session
            let loadedSession = SessionSummary(from: detail).merging(onto: currentRow)
            refreshRow(with: loadedSession, modelContext: modelContext)
            return loadedSession
        } catch {
            guard !APIError.isCancellation(error), generation == openGeneration else { return nil }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return nil
        }
    }

    /// Keeps the list row in step with what the detail authoritatively reported.
    /// `SessionRowActionPolicy` reads the row's own read-only state, so on a
    /// regular-width layout the still-visible sidebar would otherwise keep offering
    /// stale actions until the next load. Only an existing row is
    /// replaced — opening a session never adds one to the list.
    private func refreshRow(with session: SessionSummary, modelContext: ModelContext?) {
        guard claimRow(session, inserting: false),
              let modelContext,
              session.shouldAppearInSessionList
        else { return }
        do {
            try writeCacheIfCurrent { try CacheStore.cacheSession(session, serverURL: server, in: modelContext) }
        } catch {
            cacheErrorMessage = error.localizedDescription
        }
    }

    /// Puts `session` in the list and claims it against any list load already in
    /// flight, so that load's response keeps it (see `reconcilingClaimedRows`).
    /// An existing row is replaced; a missing one is added at the top only when
    /// `inserting`. Returns false when no row was claimed.
    @discardableResult
    private func claimRow(_ session: SessionSummary, inserting: Bool) -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else { return false }

        if let index = sessions.firstIndex(where: { $0.sessionId == sessionId }) {
            sessions[index] = session
        } else if inserting {
            sessions.insert(session, at: Self.insertionIndex(for: session, in: sessions))
        } else {
            return false
        }

        // A detail refresh of a row the list inserted keeps it restorable: a
        // response older than the insert still predates the row.
        let inserted = inserting || claimedRows[sessionId]?.inserted == true
        claimCount += 1
        claimedRows[sessionId] = (session, claimCount, inserted)
        return true
    }

    public func setPinned(
        _ pinned: Bool,
        for session: SessionSummary,
        modelContext: ModelContext? = nil,
        animation: Animation? = nil
    ) async -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        guard beginSessionMutation(sessionId) else { return false }
        defer { endSessionMutation(sessionId) }

        return await mutate(modelContext: modelContext, animation: animation) {
            try await sessionMutator.setPinned(pinned, sessionID: sessionId)
        }
    }

    public func archive(
        _ session: SessionSummary,
        modelContext: ModelContext? = nil,
        animation: Animation? = nil
    ) async -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        guard beginSessionMutation(sessionId) else { return false }
        var holdsMutation = true
        defer { if holdsMutation { endSessionMutation(sessionId) } }

        return await mutate(modelContext: modelContext, animation: animation) {
            try await sessionMutator.archive(sessionID: sessionId)
            // A list response requested before the archive must not restore the row.
            claimedRows.removeValue(forKey: sessionId)
            // Undo is offered now, so the reload below must not hold the session.
            endSessionMutation(sessionId)
            holdsMutation = false
            offerArchiveUndo(for: sessionId)
        }
    }

    /// Unarchives the chat behind `archiveUndo`, then reloads the list so the
    /// server's order and fields win. A failure keeps the undo offered for retry.
    public func undoArchive(modelContext: ModelContext? = nil, animation: Animation? = nil) async -> Bool {
        guard let undo = archiveUndo, beginSessionMutation(undo.sessionID) else { return false }
        defer { endSessionMutation(undo.sessionID) }
        // An attempt in flight or failed stays offered until it succeeds.
        archiveUndoTask?.cancel()

        let didUndo = await mutate(modelContext: modelContext, animation: animation) {
            try await sessionMutator.unarchive(sessionID: undo.sessionID)
            if archiveUndo?.offer == undo.offer { archiveUndo = nil }
        }
        if archiveUndo?.offer == undo.offer { archiveUndo?.undoFailed = true }
        return didUndo
    }

    public func dismissArchiveUndo() {
        archiveUndoTask?.cancel()
        archiveUndo = nil
    }

    private func offerArchiveUndo(for sessionID: String) {
        archiveUndoTask?.cancel()
        archiveUndoOffers += 1
        let undo = SessionArchiveUndo(sessionID: sessionID, offer: archiveUndoOffers)
        archiveUndo = undo
        archiveUndoTask = Task { [weak self, archiveUndoLifetime] in
            try? await Task.sleep(for: archiveUndoLifetime)
            guard !Task.isCancelled, let self, self.archiveUndo == undo else { return }
            self.archiveUndo = nil
        }
    }

    public func delete(
        _ session: SessionSummary,
        modelContext: ModelContext? = nil,
        animation: Animation? = nil
    ) async -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        guard beginSessionMutation(sessionId) else { return false }
        defer { endSessionMutation(sessionId) }

        return await mutate(modelContext: modelContext, animation: animation) {
            try await sessionMutator.delete(sessionID: sessionId)
            // A list response requested before the delete must not restore the row.
            claimedRows.removeValue(forKey: sessionId)
        }
    }

    public func isMutating(_ session: SessionSummary) -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else { return false }
        return mutatingSessionIDs.contains(sessionId)
    }

    public func rename(_ session: SessionSummary, to rawTitle: String, modelContext: ModelContext? = nil) async -> Bool {
        guard !isViewingCachedData else {
            actionErrorMessage = String(localized: "Reconnect to the server to rename a session.")
            return false
        }

        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        guard let title = Self.nonEmpty(rawTitle) else {
            actionErrorMessage = String(localized: "Enter a session title.")
            return false
        }

        isRenamingSession = true
        actionErrorMessage = nil
        lastError = nil
        defer { isRenamingSession = false }

        do {
            let response = try await sessionMutator.rename(sessionID: sessionId, title: title)
            if let error = Self.nonEmpty(response.error) {
                actionErrorMessage = error
                return false
            }

            let resolvedTitle = Self.nonEmpty(response.session?.title) ?? title
            let baseSession = sessions.first(where: { $0.sessionId == sessionId }) ?? session
            let updatedSession = baseSession.replacingTitle(with: resolvedTitle)
            // Claim the row rather than assigning it: a list load already in
            // flight was requested before this rename and still carries the old
            // title, so without the claim it would revert what the user typed.
            refreshRow(with: updatedSession, modelContext: modelContext)

            return true
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    public func duplicate(_ session: SessionSummary, modelContext: ModelContext? = nil) async -> SessionSummary? {
        guard SessionRowActionPolicy.canDuplicate(session) else {
            actionErrorMessage = String(localized: "This command is not available in the mobile app.")
            return nil
        }

        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return nil
        }

        guard beginSessionMutation(sessionId) else { return nil }
        defer { endSessionMutation(sessionId) }

        actionErrorMessage = nil
        lastError = nil

        do {
            let result = try await sessionMutator.duplicate(sessionID: sessionId)

            guard let duplicatedSession = result.session else {
                actionErrorMessage = result.errorMessage
                return nil
            }

            await load(modelContext: modelContext)
            if !sessions.contains(where: { $0.sessionId == duplicatedSession.sessionId }) {
                // The reload may have been coalesced into a load already in flight,
                // whose response predates the copy.
                claimRow(duplicatedSession, inserting: true)

                if let modelContext {
                    do {
                        try writeCacheIfCurrent { try CacheStore.cacheSessions(sessions, serverURL: server, in: modelContext) }
                    } catch {
                        cacheErrorMessage = error.localizedDescription
                    }
                }
            }
            return duplicatedSession
        } catch {
            lastError = error
            actionErrorMessage = error.localizedDescription
            return nil
        }
    }

    /// Downloads the session transcript (`GET /api/session/export`) and writes
    /// it to a unique temp directory so the share sheet can offer it as a file
    /// with a real filename. Returns the file URL, or nil after surfacing the
    /// failure through the standard action-error alert. The caller owns
    /// cleanup of the returned file's parent directory after sharing.
    public func export(_ session: SessionSummary, format: SessionExportFormat) async -> URL? {
        guard !isViewingCachedData else {
            actionErrorMessage = String(localized: "Reconnect to the server to export a session.")
            return nil
        }

        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return nil
        }

        // Reuses the per-session mutation gate: it disables the row's other
        // actions while the download runs (the "progress state") and blocks a
        // double-tap from firing two exports.
        guard beginSessionMutation(sessionId) else { return nil }
        defer { endSessionMutation(sessionId) }

        actionErrorMessage = nil
        lastError = nil

        do {
            let file = try await client.exportSession(
                id: sessionId,
                format: format,
                fallbackTitle: session.title
            )

            let directory = Self.exportsRootDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

            let fileURL = directory.appendingPathComponent(file.filename)
            try file.data.write(to: fileURL, options: .atomic)
            return fileURL
        } catch {
            guard !APIError.isCancellation(error) else { return nil }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return nil
        }
    }

    /// - Parameter silently: `true` when this reload is a side effect of loading
    ///   the session list rather than something the user asked for.
    ///   `actionErrorMessage` is presented as a modal, so only a project action
    ///   the user actually requested may fail into it — otherwise a transient
    ///   `/api/projects` failure interrupts them once per list refresh.
    public func loadProjects(silently: Bool = false) async {
        isLoadingProjects = true
        // A silent reload neither writes to the action-alert channel nor clears
        // it: an alert the user has not acknowledged yet — a rename that just
        // failed — must not be dismissed out from under them by a refresh they
        // did not ask for.
        if !silently {
            actionErrorMessage = nil
        }
        lastError = nil
        defer { isLoadingProjects = false }

        // Advance for this request as well as for mutations, so of two reloads
        // in flight only the later one applies. `load` fences itself the same
        // way; without it a delayed earlier response could overwrite a newer
        // snapshot when a project changes remotely between the two.
        projectsGeneration += 1
        let generation = projectsGeneration
        do {
            let response = try await client.projects(caching: responseCache?.entry(ResponseCache.Kind.projects))
            // A project the user created, renamed or deleted while this request
            // was in flight is newer than the snapshot it returns, so adopting
            // it would make that mutation disappear until the next refresh.
            guard generation == projectsGeneration else { return }
            projects = response.projects ?? []
        } catch {
            guard !APIError.isCancellation(error) else { return }

            lastError = error
            if !silently {
                actionErrorMessage = error.localizedDescription
            }
        }
    }

    public func move(_ session: SessionSummary, to projectID: String?, modelContext: ModelContext? = nil) async {
        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return
        }

        guard beginSessionMutation(sessionId) else { return }
        defer { endSessionMutation(sessionId) }

        isMovingSession = true
        defer { isMovingSession = false }

        _ = await mutate(modelContext: modelContext) {
            try await sessionMutator.move(sessionID: sessionId, to: projectID)
        }
    }

    public func createProject(
        named rawName: String,
        color: String,
        moving session: SessionSummary,
        modelContext: ModelContext? = nil
    ) async -> Bool {
        actionErrorMessage = nil
        lastError = nil

        guard let sessionId = session.sessionId else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            actionErrorMessage = String(localized: "Enter a project name.")
            return false
        }

        isCreatingProject = true
        isMovingSession = true
        defer {
            isCreatingProject = false
            isMovingSession = false
        }

        do {
            let createResponse = try await client.createProject(name: name, color: color)
            guard let project = createResponse.project else {
                actionErrorMessage = createResponse.error ?? String(localized: "The server did not return the new project.")
                return false
            }

            guard let projectID = project.projectId, !projectID.isEmpty else {
                actionErrorMessage = createResponse.error ?? String(localized: "The server did not return the new project ID.")
                return false
            }

            upsertProject(project)
            try await sessionMutator.move(sessionID: sessionId, to: projectID)
            await load(modelContext: modelContext)
            return true
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Creates a new project without moving any session into it.
    ///
    /// Mirrors ``createProject(named:color:moving:modelContext:)`` but skips the
    /// `sessionMutator.move(...)` step, so the Projects sidebar's standalone
    /// "Add project" button can make an empty, unassigned project.
    public func createEmptyProject(
        named rawName: String,
        color: String,
        modelContext: ModelContext? = nil
    ) async -> Bool {
        actionErrorMessage = nil
        lastError = nil

        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            actionErrorMessage = String(localized: "Enter a project name.")
            return false
        }

        isCreatingProject = true
        defer { isCreatingProject = false }

        do {
            let createResponse = try await client.createProject(name: name, color: color)
            guard let project = createResponse.project else {
                actionErrorMessage = createResponse.error ?? String(localized: "The server did not return the new project.")
                return false
            }

            guard let projectID = project.projectId, !projectID.isEmpty else {
                actionErrorMessage = createResponse.error ?? String(localized: "The server did not return the new project ID.")
                return false
            }

            upsertProject(project)
            await load(modelContext: modelContext)
            return true
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    public func delete(_ project: ProjectSummary, modelContext: ModelContext? = nil) async -> Bool {
        guard let projectID = project.projectId, !projectID.isEmpty else {
            actionErrorMessage = String(localized: "The server did not provide a project ID.")
            return false
        }

        isDeletingProject = true
        actionErrorMessage = nil
        lastError = nil
        defer { isDeletingProject = false }

        do {
            _ = try await client.deleteProject(id: projectID)
            projectsGeneration += 1
            projects.removeAll { $0.projectId == projectID }
            await load(modelContext: modelContext)
            return true
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    public func rename(_ project: ProjectSummary, named rawName: String, color: String?) async -> Bool {
        actionErrorMessage = nil
        lastError = nil

        guard let projectID = project.projectId, !projectID.isEmpty else {
            actionErrorMessage = String(localized: "The server did not provide a project ID.")
            return false
        }

        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            actionErrorMessage = String(localized: "Enter a project name.")
            return false
        }

        isRenamingProject = true
        defer { isRenamingProject = false }

        do {
            let response = try await client.renameProject(id: projectID, name: name, color: color)
            guard let renamedProject = response.project else {
                actionErrorMessage = response.error ?? String(localized: "The server did not return the renamed project.")
                return false
            }

            guard renamedProject.projectId?.isEmpty == false else {
                actionErrorMessage = response.error ?? String(localized: "The server did not return the renamed project ID.")
                return false
            }

            upsertProject(renamedProject)
            return true
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Creates a new session. `profile` pins it to a specific server profile (the "New Chat
    /// in <Profile>" App Intent, #339); nil keeps the legacy behavior of letting the server
    /// use its active profile (the "+" button / plain New Chat). `projectID` files it under the
    /// project the list is filtered to (TAL-455); the row shows the server's returned `project_id`.
    public func createSession(
        modelContext: ModelContext? = nil,
        profile: String? = nil,
        provider: String? = nil,
        projectID: String? = nil
    ) async -> SessionSummary? {
        isCreatingSession = true
        actionErrorMessage = nil
        lastError = nil
        defer { isCreatingSession = false }

        do {
            let workspaces = try await client.workspaces()
            let workspace = workspaces.last ?? workspaces.workspaces?.compactMap(\.path).first
            let requestedProvider = Self.nonEmpty(provider)
            let requestedModel: ModelCatalogOption?
            if let requestedProvider,
               let models = try? await client.models() {
                requestedModel = models.catalogGroups
                    .first(where: { $0.providerID == requestedProvider })?
                    .slashAutocompleteModels.first
            } else {
                requestedModel = nil
            }
            let response = try await client.createSession(
                workspace: workspace,
                model: requestedModel?.id,
                modelProvider: requestedModel?.providerID,
                profile: Self.nonEmpty(profile),
                projectID: Self.nonEmpty(projectID)
            )

            guard let sessionDetail = response.session else {
                actionErrorMessage = String(localized: "The server did not return the new session.")
                return nil
            }

            let newSession = SessionSummary(from: sessionDetail)
            guard newSession.sessionId?.isEmpty == false else {
                actionErrorMessage = String(localized: "The server did not return the new session ID.")
                return nil
            }

            if newSession.shouldAppearInSessionList {
                claimRow(newSession, inserting: true)

                if let modelContext {
                    do {
                        try writeCacheIfCurrent { try CacheStore.cacheSession(newSession, serverURL: server, in: modelContext) }
                    } catch {
                        cacheErrorMessage = error.localizedDescription
                    }
                }
            }

            return newSession
        } catch {
            guard !APIError.isCancellation(error) else { return nil }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return nil
        }
    }

    public func clearActionError() {
        actionErrorMessage = nil
    }

    /// Drops any empty Untitled placeholders still held in memory. Used when
    /// returning from the pending new-chat flow so stale rows cannot flash during
    /// the navigation pop animation.
    public func removeEmptySidebarPlaceholders() {
        let filtered = sessions.filter(\.shouldAppearInSessionList)
        guard filtered.count != sessions.count else { return }
        sessions = filtered
    }

    private static func normalizedSearchQuery(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    public static func activeStreamIDs(in sessions: [SessionSummary]) -> [String] {
        normalizedStreamIDs(sessions.compactMap(\.activeStreamId))
    }

    private static func normalizedStreamIDs(_ rawStreamIDs: [String]) -> [String] {
        Array(Set(rawStreamIDs.compactMap(nonEmpty))).sorted()
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Where a row the list adds locally goes until the next server list: the top of its
    /// pin section, since the server lists pinned rows first (TAL-306).
    private static func insertionIndex(for session: SessionSummary, in sessions: [SessionSummary]) -> Int {
        session.pinned == true ? 0 : sessions.firstIndex { $0.pinned != true } ?? sessions.endIndex
    }

    /// `archivedCount` is applied inside the same transaction as the rows so the
    /// bottom Archived entry inserts/removes with the list mutation animation.
    private func applySessions(
        _ newSessions: [SessionSummary],
        archivedCount newArchivedCount: Int?,
        animation: Animation?,
        claimCountAtStart: Int = Int.max
    ) {
        let reconciledSessions = reconcilingClaimedRows(
            in: newSessions,
            claimCountAtStart: claimCountAtStart
        )

        guard let animation else {
            sessions = reconciledSessions
            archivedCount = newArchivedCount
            return
        }

        withAnimation(animation) {
            sessions = reconciledSessions
            archivedCount = newArchivedCount
        }
    }

    /// Keeps a claimed row when the list response being applied was requested
    /// before the claim: a detail's authoritative metadata wins over the row the
    /// response captured, and an inserted row the response predates is put back at
    /// the top of its pin section, newest claim first. Only a load that started after the claim
    /// already reflects it, so only then do its rows win and the record get dropped.
    private func reconcilingClaimedRows(
        in newSessions: [SessionSummary],
        claimCountAtStart: Int
    ) -> [SessionSummary] {
        guard !claimedRows.isEmpty else { return newSessions }

        claimedRows = claimedRows.filter { $0.value.claim > claimCountAtStart }
        guard !claimedRows.isEmpty else { return newSessions }

        let listedIDs = Set(newSessions.compactMap(\.sessionId))
        let missingInserts = claimedRows.values
            .filter { $0.inserted && !listedIDs.contains($0.session.sessionId ?? "") }
            .sorted { $0.claim > $1.claim }
            .map(\.session)

        var reconciled = newSessions.map { session in
            guard let sessionID = session.sessionId,
                  let claimed = claimedRows[sessionID]
            else { return session }

            return claimed.session.merging(onto: session)
        }
        // Oldest claim first, each to the top of its section, so the newest ends up on top.
        for session in missingInserts.reversed() {
            reconciled.insert(session, at: Self.insertionIndex(for: session, in: reconciled))
        }
        return reconciled
    }

    /// Mirrors upstream `_sessionSearchContentPreview`: collapse whitespace and
    /// drop an empty excerpt. The text itself is shown as the server sent it,
    /// redaction markers included.
    private static func normalizedMatchPreview(_ preview: String?) -> String? {
        guard let preview else { return nil }
        let collapsed = preview.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return collapsed.isEmpty ? nil : collapsed
    }

    private func beginSessionMutation(_ sessionId: String) -> Bool {
        mutatingSessionIDs.insert(sessionId).inserted
    }

    private func endSessionMutation(_ sessionId: String) {
        mutatingSessionIDs.remove(sessionId)
    }

    private func upsertProject(_ project: ProjectSummary) {
        guard let projectID = project.projectId, !projectID.isEmpty else { return }

        projectsGeneration += 1
        if let existingIndex = projects.firstIndex(where: { $0.projectId == projectID }) {
            projects[existingIndex] = project
        } else {
            projects.append(project)
        }
    }

    private func applyActiveProfile(
        _ response: ProfilesResponse,
        fallbackProfile: ProfileSummary? = nil,
        fallbackDefaultModel: String? = nil
    ) {
        profileOptions = response.profiles ?? profileOptions

        // Tolerant: only a present field moves the flag, so an older server
        // (or the carried-forward switch-response value) keeps today's behavior.
        if let singleProfileMode = response.singleProfileMode {
            isSingleProfileMode = singleProfileMode
        }

        // Keep the App Intents profile cache fresh so the "New Chat in <Profile>" picker
        // (#339) stays populated when the Shortcuts app resolves it in the background, where
        // a live, authenticated fetch may not be possible, then nudge the system to (re-)index
        // the parameterized App Shortcut (iOS only indexes it once its suggested values exist).
        // A nil `profiles` (field absent/undecoded) is left untouched — tolerant decoding — but
        // an explicit empty list is forwarded so `save([])` can clear a stale picker if the
        // server ever reports none.
        if let profiles = response.profiles {
            let changed = ProfileEntityCache.shared.save(profiles)
            PlatformHooks.refreshProfileShortcuts(changed)
        }

        let profileName = response.effectiveDefaultProfileName
        let profile = response.profile(matching: profileName) ?? fallbackProfile

        activeProfileName = profileName
        activeProfileDisplayName = response.displayName(for: profileName)
            ?? profile?.displayName
        activeProfileModel = Self.nonEmpty(profile?.model) ?? Self.nonEmpty(fallbackDefaultModel)
        activeProfileProvider = Self.nonEmpty(profile?.provider)
    }

    private func mutate(
        modelContext: ModelContext? = nil,
        animation: Animation? = nil,
        _ operation: () async throws -> Void
    ) async -> Bool {
        actionErrorMessage = nil
        lastError = nil

        do {
            try await operation()
            return await load(modelContext: modelContext, animation: animation)
        } catch {
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

}

/// A just-archived chat the list can restore (TAL-443).
public struct SessionArchiveUndo: Equatable, Sendable {
    public let sessionID: String
    /// The last undo attempt failed; the toast offers Try Again.
    public internal(set) var undoFailed = false
    let offer: Int
}

/// The query and project a remote search answered; its result shows only for the same pair.
private struct RemoteSearchScope: Equatable {
    let query: String
    let projectID: String?
}
