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
    public var isCreatingProject: Bool { pendingChanges["project:new"].map { !$0.requiresRefresh } ?? false }
    public private(set) var isLoadingProjects = false
    public var isDeletingProject: Bool { pendingChanges.contains { $0.key.hasPrefix("project:") && $0.value.title == nil } }
    public var isRenamingSession: Bool { pendingChanges.contains { $0.key.hasPrefix("session:") && $0.value.title != nil } }
    public var isRenamingProject: Bool { pendingChanges.contains { $0.key.hasPrefix("project:") && $0.key != "project:new" && $0.value.title != nil } }
    public var isMovingSession: Bool { pendingChanges.values.contains { $0.isMoving } }
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
    /// Select Chats (TAL-627): the picked rows, kept by ID so a list reload or a search
    /// change does not drop a selection the user can no longer see.
    public private(set) var isSelectingSessions = false
    public private(set) var selectedSessionsByID: [String: SessionSummary] = [:]
    public private(set) var isPerformingBulkAction = false
    /// Total archived sessions reported by the last successful list load
    /// (`archived_count`, issue #17). nil until a load succeeds or when an older
    /// server omits the field — the Archived entry stays hidden then.
    public private(set) var archivedCount: Int?
    /// Server totals for the automated-session groups from the last successful list
    /// load (TAL-482). nil until then or from an older server; the groups then count
    /// the loaded rows instead.
    public private(set) var automatedSessionCounts: AutomatedSessionCounts?
    /// The Agent's session storage health from the last list load (TAL-830), kept in the response cache so a
    /// relaunch still explains an empty list. nil until then or from an older server.
    public private(set) var agentStorage: AgentStorage?
    /// The latest archive the Chats list still offers to undo (TAL-443). A second
    /// archive replaces it, so only the latest one is undoable.
    public private(set) var archiveUndo: SessionArchiveUndo?
    private var archiveUndoTask: Task<Void, Never>?
    private var archiveUndoOffers = 0

    /// The server's complete, ordered result for `activeRemoteSearch` (TAL-308);
    /// nil until it arrives, while the list shows local title matches.
    private(set) var remoteSearchResults: [SessionSummary]?
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
    public private(set) var pendingChanges: [String: PendingResourceChange] = [:]
    private var resourceGeneration = 0
    private var removedRows: [String: Int] = [:]
    private var resourceCacheContext = UUID()
    private var resourceCacheVersions: [String: UUID] = [:]
    public func resourceCacheVersion(for id: String) -> UUID { resourceCacheVersions[id] ?? resourceCacheContext }

    private var metadataVersions: [String: Int] = [:]

    public func resourceMetadataVersion(for id: String) -> Int { metadataVersions[id] ?? 0 }
    public func confirmedTitle(for id: String) -> String? { sessions.first { $0.sessionId == id }?.title }
    private func resourceReadVersion(for id: String) -> (UUID, Int) {
        (resourceCacheVersion(for: id), resourceMetadataVersion(for: id))
    }

    public func pendingChange(for session: SessionSummary) -> PendingResourceChange? {
        session.sessionId.flatMap { pendingChanges["session:\($0)"] }
    }

    public func pendingChange(for project: ProjectSummary) -> PendingResourceChange? {
        project.projectId.flatMap { pendingChanges["project:\($0)"] }
    }

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
    /// How long a chat archive stays undoable.
    public static let defaultArchiveUndoLifetime: Duration = .seconds(5)

    public init(
        server: URL,
        client: APIClient? = nil,
        responseCache: ResponseCache? = nil,
        archiveUndoLifetime: Duration = defaultArchiveUndoLifetime
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
        // The server's order is canonical (TAL-306).
        guard !query.isEmpty else {
            return projectFilteredSessions
        }

        let titleMatches: (SessionSummary) -> Bool = { $0.title?.lowercased().contains(query) == true }
        guard activeRemoteSearch == RemoteSearchScope(query: query, projectID: selectedProjectID),
              let remoteSearchResults
        else {
            return projectFilteredSessions.filter(titleMatches)
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
        if agentStorage == nil {
            agentStorage = responseCache?.entry(ResponseCache.Kind.agentStorage).load(AgentStorage.self)
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
        let scope = resourceGeneration
        for session in sessions where session.isStreaming == true {
            guard scope == resourceGeneration else { return }
            guard let sessionID = Self.nonEmpty(session.sessionId) else { continue }
            let runKey = "\(sessionID)|\(session.activeStreamId ?? "")"
            guard !prefetchedRuns.contains(runKey) else { continue }
            let cacheVersion = resourceCacheVersion(for: sessionID)
            prefetchedRuns.insert(runKey)
            // A chat opened here already has its own cache, which the chat keeps current. Checked
            // again after the request, in case the chat saved a newer transcript meanwhile.
            guard !hasCachedTranscript(sessionID, in: modelContext),
                  let messages = try? await client.session(
                    id: sessionID,
                    messageLimit: ChatViewModel.messagePageLimit,
                    expandRenderable: true
                  ).session?.messages,
                  cacheVersion == resourceCacheVersion(for: sessionID),
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

        // Resolved before the request, so a list in flight across a profile switch cannot cache for the new profile.
        let agentStorageEntry = responseCache?.entry(ResponseCache.Kind.agentStorage)
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
            agentStorage = response.agentStorage
            if let data = try? JSONEncoder().encode(response.agentStorage) {
                agentStorageEntry?.save(data)
            }
            pendingChanges = pendingChanges.filter { key, change in
                guard key.hasPrefix("session:") else { return true }
                if let claim = change.snapshotClaim { return claim > claimCountAtStart }
                return !change.requiresRefresh
            }
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
            // Selected chats belong to the old profile; the server would refuse them now.
            isSelectingSessions = false
            selectedSessionsByID = [:]
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

        let version = resourceReadVersion(for: sessionID)
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
            guard version == resourceReadVersion(for: sessionID) else { return nil }
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
            guard version == resourceReadVersion(for: sessionID) else { return nil }
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

        let version = resourceReadVersion(for: sessionId)
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
            guard generation == openGeneration, version == resourceReadVersion(for: sessionId) else { return nil }

            // A list refresh can land while the load is in flight, so the merge base is
            // the current row rather than the pre-await snapshot — otherwise
            // `refreshRow` would roll the freshly loaded row back to stale list-only
            // metadata.
            let currentRow = sessions.first(where: { $0.sessionId == sessionId }) ?? session
            let loadedSession = SessionSummary(from: detail).merging(onto: currentRow)
            refreshRow(with: loadedSession, modelContext: modelContext)
            return loadedSession
        } catch {
            guard !APIError.isCancellation(error), generation == openGeneration, version == resourceReadVersion(for: sessionId) else { return nil }

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
        await changeSession(session, label: pinned ? String(localized: "Pin") : String(localized: "Unpin"), modelContext: modelContext, animation: animation) { id in
            try await self.sessionMutator.setPinned(pinned, sessionID: id)
        }
    }

    public func archive(
        _ session: SessionSummary,
        modelContext: ModelContext? = nil,
        animation: Animation? = nil
    ) async -> Bool {
        await changeSession(session, label: String(localized: "Archive"), removing: true, offerUndo: true, modelContext: modelContext, animation: animation) { id in
            try await self.sessionMutator.archive(sessionID: id)
        }
    }

    /// Unarchives the chat behind `archiveUndo`, then reloads the list so the
    /// server's order and fields win. A failure keeps the undo offered for retry.
    public func undoArchive(modelContext: ModelContext? = nil, animation: Animation? = nil) async -> Bool {
        guard let undo = archiveUndo else { return false }
        archiveUndoTask?.cancel()
        let didUndo = await changeSession(SessionSummary(sessionId: undo.sessionID), label: String(localized: "Restore"), modelContext: modelContext, animation: animation, confirmed: {
            self.removedRows.removeValue(forKey: undo.sessionID)
            if self.archiveUndo?.offer == undo.offer { self.archiveUndo = nil }
        }) { id in
            try await self.sessionMutator.unarchive(sessionID: id)
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
        await changeSession(session, label: String(localized: "Delete"), removing: true, clearTranscript: true, modelContext: modelContext, animation: animation) { id in
            try await self.sessionMutator.delete(sessionID: id)
        }
    }

    static let bulkActionLimit = 200

    public var selectedSessionCount: Int { selectedSessionsByID.count }

    /// ponytail: old-server fallback (TAL-627). A server that ships `can_delete` also serves
    /// `/api/sessions/bulk`; delete this check once every supported server does.
    public var supportsBulkActions: Bool {
        sessions.contains { $0.canDelete != nil }
    }

    public func isSelected(_ session: SessionSummary) -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else { return false }
        return selectedSessionsByID[sessionId] != nil
    }

    /// Whether any selected row allows the action. The server still answers for each ID.
    public func canPerformBulkAction(_ action: SessionBulkAction) -> Bool {
        guard !isPerformingBulkAction, !isViewingCachedData else { return false }
        return selectedSessionsByID.values.contains {
            !isMutating($0) && (action == .delete ? SessionRowActionPolicy.canDelete($0) : SessionRowActionPolicy.canArchive($0))
        }
    }

    public func beginSelectingSessions() {
        guard !isPerformingBulkAction else { return }
        isSelectingSessions = true
    }

    public func endSelectingSessions() {
        guard !isPerformingBulkAction else { return }
        isSelectingSessions = false
        selectedSessionsByID = [:]
    }

    public func toggleSelection(_ session: SessionSummary) {
        guard isSelectingSessions,
              !isPerformingBulkAction,
              SessionRowActionPolicy.isBulkSelectable(session),
              let sessionId = Self.nonEmpty(session.sessionId)
        else { return }
        if selectedSessionsByID.removeValue(forKey: sessionId) == nil {
            selectedSessionsByID[sessionId] = session
        }
    }

    public func allSelected(_ sessions: [SessionSummary]) -> Bool {
        let selectable = sessions.filter(SessionRowActionPolicy.isBulkSelectable)
        return !selectable.isEmpty && selectable.allSatisfy(isSelected)
    }

    /// Selects every selectable row in `sessions`, or clears the selection when they are all selected.
    public func toggleSelectAll(_ sessions: [SessionSummary]) {
        guard isSelectingSessions, !isPerformingBulkAction else { return }
        let selectable = sessions.filter(SessionRowActionPolicy.isBulkSelectable)
        if allSelected(selectable) {
            selectedSessionsByID = [:]
        } else {
            for session in selectable {
                if let sessionId = Self.nonEmpty(session.sessionId) { selectedSessionsByID[sessionId] = session }
            }
        }
    }

    /// Runs one bulk call for every selected ID and returns the sessions the server
    /// changed. Failed IDs stay selected and the alert names how many failed and why;
    /// the mode ends once nothing is left selected.
    public func performBulkAction(
        _ action: SessionBulkAction,
        modelContext: ModelContext? = nil,
        animation: Animation? = nil
    ) async -> [SessionSummary] {
        let sessionIDs = selectedSessionsByID.keys.filter { !mutatingSessionIDs.contains($0) && pendingChanges["session:\($0)"] == nil }.sorted()
        guard !sessionIDs.isEmpty, !isPerformingBulkAction, !isViewingCachedData, !isSwitchingActiveProfile else { return [] }

        let scope = resourceGeneration
        let label = action == .delete ? String(localized: "Delete") : action == .archive ? String(localized: "Archive") : String(localized: "Restore")
        let changes = Dictionary(uniqueKeysWithValues: sessionIDs.map { ($0, PendingResourceChange(label: label, title: nil, color: nil)) })
        for (id, change) in changes { pendingChanges["session:\(id)"] = change }
        isPerformingBulkAction = true
        mutatingSessionIDs.formUnion(sessionIDs)
        defer {
            if scope == resourceGeneration {
                isPerformingBulkAction = false
                mutatingSessionIDs.subtract(sessionIDs)
                for (id, change) in changes where pendingChanges["session:\(id)"]?.id == change.id && pendingChanges["session:\(id)"]?.requiresRefresh != true && pendingChanges["session:\(id)"]?.snapshotClaim == nil {
                    pendingChanges.removeValue(forKey: "session:\(id)")
                }
            }
        }
        actionErrorMessage = nil
        lastError = nil

        // The route takes at most `bulkActionLimit` IDs a call (the contract's cap).
        var results: [SessionBulkResult] = []
        var changed: [SessionSummary] = []
        do {
            for start in stride(from: 0, to: sessionIDs.count, by: Self.bulkActionLimit) {
                let chunk = Array(sessionIDs[start..<min(start + Self.bulkActionLimit, sessionIDs.count)])
                let response = try await sessionMutator.bulk(action, sessionIDs: chunk)
                guard scope == resourceGeneration else { return [] }
                let chunkResults = (response.results ?? []).filter { chunk.contains($0.sessionId ?? "") }
                results += chunkResults
                var removedIDs: [String] = []
                for result in chunkResults {
                    guard let id = result.sessionId else { continue }
                    if result.ok == true, let session = selectedSessionsByID.removeValue(forKey: id) {
                        metadataVersions[id, default: 0] += 1
                        if action != .unarchive { removedIDs.append(id) }
                        changed.append(session)
                    }
                    // Stop marking an answered item pending while later chunks run.
                    pendingChanges.removeValue(forKey: "session:\(id)")
                }
                removeConfirmedRows(removedIDs, clearTranscript: action == .delete, modelContext: modelContext)
            }
        } catch {
            guard scope == resourceGeneration else { return [] }
            if !APIError.isCancellation(error) {
                lastError = error
                actionErrorMessage = error.localizedDescription
            }
        }
        guard scope == resourceGeneration else { return [] }
        var messages: [String] = []
        let failedIDs = sessionIDs.filter { selectedSessionsByID[$0] != nil }
        if !failedIDs.isEmpty {
            let failure = results.first { $0.ok != true }?.error
                ?? actionErrorMessage
                ?? String(localized: "The server did not report a result.")
            messages.append(String(
                localized: "Failed for \(failedIDs.count) of \(sessionIDs.count) chats: \(failure)"
            ))
        } else if selectedSessionsByID.isEmpty {
            isSelectingSessions = false
        }
        let keptByAgent = results.filter { $0.ok == true && $0.stateDbCleanupFailed == true }.count
        if keptByAgent > 0 {
            messages.append(String(localized: "The Agent kept its copy of \(keptByAgent) deleted chats, so they may reappear."))
        }
        actionErrorMessage = messages.isEmpty ? nil : messages.joined(separator: "\n\n")

        claimCount += 1
        for id in sessionIDs where pendingChanges["session:\(id)"] != nil {
            pendingChanges["session:\(id)"]?.snapshotClaim = claimCount
        }
        let reconciled = await load(modelContext: modelContext, animation: animation)
        guard scope == resourceGeneration else { return [] }
        if !reconciled {
            for id in sessionIDs where selectedSessionsByID[id] != nil {
                if var pending = pendingChanges["session:\(id)"] { pending.requiresRefresh = true; pendingChanges["session:\(id)"] = pending }
            }
        }
        return changed
    }

    public func isMutating(_ session: SessionSummary) -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else { return false }
        return mutatingSessionIDs.contains(sessionId) || pendingChanges["session:\(sessionId)"] != nil
    }

    public func rename(_ session: SessionSummary, to rawTitle: String, modelContext: ModelContext? = nil) async -> Bool {
        guard !isViewingCachedData else {
            actionErrorMessage = String(localized: "Reconnect to the server to rename a session.")
            return false
        }
        guard let title = Self.nonEmpty(rawTitle) else {
            actionErrorMessage = String(localized: "Enter a session title.")
            return false
        }
        guard pendingChange(for: session) == nil else { return false }

        var renamed: SessionSummary?
        return await changeSession(session, label: String(localized: "Rename"), title: title, modelContext: modelContext, reload: false, confirmed: {
            if let renamed, let id = renamed.sessionId {
                self.refreshRow(with: renamed, modelContext: modelContext)
            }
        }) { id in
            let response = try await self.sessionMutator.rename(sessionID: id, title: title)
            guard response.session?.sessionId == id, let resolvedTitle = Self.nonEmpty(response.session?.title) else {
                throw ResourceMutationError(message: String(localized: "The server did not return the renamed session title."))
            }
            let base = self.sessions.first { $0.sessionId == id } ?? session
            renamed = base.replacingTitle(with: resolvedTitle)
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
        let scope = resourceGeneration
        defer { if scope == resourceGeneration { endSessionMutation(sessionId) } }

        actionErrorMessage = nil
        lastError = nil

        do {
            let result = try await sessionMutator.duplicate(sessionID: sessionId)
            guard scope == resourceGeneration else { return nil }

            guard let duplicatedSession = result.session else {
                actionErrorMessage = result.errorMessage
                return nil
            }

            await load(modelContext: modelContext)
            guard scope == resourceGeneration else { return nil }
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
            guard scope == resourceGeneration else { return nil }
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
        let scope = resourceGeneration
        defer { if scope == resourceGeneration { endSessionMutation(sessionId) } }

        actionErrorMessage = nil
        lastError = nil

        do {
            let file = try await client.exportSession(
                id: sessionId,
                format: format,
                fallbackTitle: session.title
            )

            guard scope == resourceGeneration else { return nil }
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
    @discardableResult
    public func loadProjects(silently: Bool = false) async -> Bool {
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
            guard generation == projectsGeneration else { return false }
            projects = response.projects ?? []
            pendingChanges = pendingChanges.filter { !$0.key.hasPrefix("project:") || !$0.value.requiresRefresh }
            return true
        } catch {
            guard generation == projectsGeneration else { return false }
            guard !APIError.isCancellation(error) else { return false }

            lastError = error
            if !silently {
                actionErrorMessage = error.localizedDescription
            }
            return false
        }
    }

    public func move(_ session: SessionSummary, to projectID: String?, modelContext: ModelContext? = nil) async {
        let projectName = projects.first { $0.projectId == projectID }?.name ?? String(localized: "No Project")

        _ = await changeSession(session, label: String(localized: "Move to \(projectName)"), moving: true, modelContext: modelContext) { id in
            try await self.sessionMutator.move(sessionID: id, to: projectID)
        }
    }

    public func createProject(
        named rawName: String,
        color: String,
        moving session: SessionSummary,
        modelContext: ModelContext? = nil
    ) async -> Bool {
        guard let id = Self.nonEmpty(session.sessionId), beginSessionMutation(id) else { return false }
        let scope = resourceGeneration
        var holdsCreationClaim = true

        defer {
            if scope == resourceGeneration { if holdsCreationClaim { endSessionMutation(id) } }
        }
        guard let project = await createProject(named: rawName, color: color), scope == resourceGeneration else { return false }
        // Release the creation claim before entering the shared move owner.
        holdsCreationClaim = false
        endSessionMutation(id)
        await move(session, to: project.projectId, modelContext: modelContext)
        return actionErrorMessage == nil && scope == resourceGeneration
    }

    public func createEmptyProject(
        named rawName: String,
        color: String,
        modelContext: ModelContext? = nil
    ) async -> Bool {
        let scope = resourceGeneration
        guard await createProject(named: rawName, color: color) != nil, scope == resourceGeneration else { return false }
        _ = await load(modelContext: modelContext)
        return true
    }

    /// Both creation entry points share one provisional row and adopt only the returned server identity.
    private func createProject(named rawName: String, color: String) async -> ProjectSummary? {
        guard let name = Self.nonEmpty(rawName) else {
            actionErrorMessage = String(localized: "Enter a project name.")
            return nil
        }
        guard pendingChanges["project:new"] == nil else {
            if pendingChanges["project:new"]?.requiresRefresh == true {
                actionErrorMessage = String(localized: "The previous creation has an unknown outcome. Refresh projects before trying again.")
            }
            return nil
        }

        var created: ProjectSummary?
        let success = await changeResource(key: "project:new", label: String(localized: "Create"), title: name, color: color, reconcileFailure: true) {
            let response = try await self.client.createProject(name: name, color: color)
            try validateResourceMutation(ok: response.ok, error: response.error)
            guard let project = response.project else {
                throw ResourceMutationError(message: String(localized: "The server did not return the new project."))
            }
            guard Self.nonEmpty(project.projectId) != nil else {
                throw ResourceMutationError(message: String(localized: "The server did not return the new project ID."))
            }
            return project
        } confirmed: { project in
            created = project
            self.upsertProject(project)
        } reconcile: { committed in
            if committed { return true }
            return await self.loadProjects(silently: true)
        }
        return success ? created : nil
    }

    public func delete(_ project: ProjectSummary, modelContext: ModelContext? = nil) async -> Bool {
        guard let id = Self.nonEmpty(project.projectId) else { return false }
        guard pendingChanges["project:\(id)"] == nil else { return false }

        return await changeResource(key: "project:\(id)", label: String(localized: "Delete")) {
            let response = try await self.client.deleteProject(id: id)
            try validateResourceMutation(ok: response.ok, error: response.error)
        } confirmed: { _ in
            self.projectsGeneration += 1
            self.projects.removeAll { $0.projectId == id }
        } reconcile: { committed in
            if !committed { await self.loadProjects(silently: true) }
            return await self.load(modelContext: modelContext)
        }
    }

    public func rename(_ project: ProjectSummary, named rawName: String, color: String?) async -> Bool {
        guard let id = Self.nonEmpty(project.projectId), let name = Self.nonEmpty(rawName) else {
            actionErrorMessage = String(localized: "Enter a project name.")
            return false
        }
        guard pendingChanges["project:\(id)"] == nil else { return false }

        return await changeResource(key: "project:\(id)", label: String(localized: "Rename"), title: name, color: color) {
            let response = try await self.client.renameProject(id: id, name: name, color: color)
            try validateResourceMutation(ok: response.ok, error: response.error)
            guard let project = response.project, project.projectId == id else {
                throw ResourceMutationError(message: String(localized: "The server did not return the renamed project ID."))
            }
            return project
        } confirmed: { self.upsertProject($0) } reconcile: { committed in
            if committed { return true }
            return await self.loadProjects(silently: true)
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
        removedRows = removedRows.filter { $0.value > claimCountAtStart }
        let newSessions = newSessions.filter { removedRows[$0.sessionId ?? ""] == nil }
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
        guard !isSwitchingActiveProfile, pendingChanges["session:\(sessionId)"] == nil else { return false }
        return mutatingSessionIDs.insert(sessionId).inserted
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

        if (activeProfileName != nil && activeProfileName != profileName) || isSwitchingActiveProfile {
            resourceGeneration += 1
            isPerformingBulkAction = false

            pendingChanges = [:]
            mutatingSessionIDs = []
            claimedRows = [:]
            removedRows = [:]
            metadataVersions = [:]
            resourceCacheContext = UUID()
            resourceCacheVersions = [:]
            dismissArchiveUndo()
            loadGeneration += 1
            projectsGeneration += 1
        }
        activeProfileName = profileName
        activeProfileDisplayName = response.displayName(for: profileName)
            ?? profile?.displayName
        activeProfileModel = Self.nonEmpty(profile?.model) ?? Self.nonEmpty(fallbackDefaultModel)
        activeProfileProvider = Self.nonEmpty(profile?.provider)
    }

    private func removeConfirmedRows(_ ids: [String], clearTranscript: Bool = false, modelContext: ModelContext?) {
        guard !ids.isEmpty else { return }
        let removedIDs = Set(ids)
        for id in removedIDs {
            claimCount += 1
            removedRows[id] = claimCount
            claimedRows.removeValue(forKey: id)
            selectedSessionsByID.removeValue(forKey: id)
            if clearTranscript { resourceCacheVersions[id] = UUID() }
        }
        sessions.removeAll { $0.sessionId.map(removedIDs.contains) == true }
        if let modelContext {
            do {
                try writeCacheIfCurrent {
                    if clearTranscript { try CacheStore.clearCache(for: server, sessionIDs: ids, in: modelContext) }
                    else { try CacheStore.cacheSessions(sessions, serverURL: server, in: modelContext) }
                }
            }
            catch { cacheErrorMessage = error.localizedDescription }
        }
    }

    private func changeSession(
        _ session: SessionSummary,
        label: String,
        title: String? = nil,
        removing: Bool = false,
        moving: Bool = false,
        clearTranscript: Bool = false,
        offerUndo: Bool = false,
        modelContext: ModelContext? = nil,
        animation: Animation? = nil,
        reload: Bool = true,
        confirmed: () -> Void = {},
        operation: (String) async throws -> Void
    ) async -> Bool {
        guard let id = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }
        guard beginSessionMutation(id) else { return false }
        let scope = resourceGeneration
        var released = false
        defer { if !released && scope == resourceGeneration { endSessionMutation(id) } }
        return await changeResource(key: "session:\(id)", label: label, title: title, releaseAfterWrite: offerUndo, isMoving: moving, awaitsSessionSnapshot: reload && !offerUndo) {
            try await operation(id)
        } confirmed: { _ in
            self.metadataVersions[id, default: 0] += 1
            if removing { self.removeConfirmedRows([id], clearTranscript: clearTranscript, modelContext: modelContext) }
            confirmed()
            if offerUndo {
                self.endSessionMutation(id)
                released = true
                self.offerArchiveUndo(for: id)
            }
        } reconcile: { committed in
            if !reload && committed { return true }
            return await self.load(modelContext: modelContext, animation: animation)
        }
    }

    private func changeResource<Result>(
        key: String,
        label: String,
        title: String? = nil,
        color: String? = nil,
        releaseAfterWrite: Bool = false,
        reconcileFailure: Bool = false,
        isMoving: Bool = false,
        awaitsSessionSnapshot: Bool = false,
        operation: () async throws -> Result,
        confirmed: (Result) -> Void,
        reconcile: (Bool) async -> Bool
    ) async -> Bool {
        guard !isViewingCachedData, !isSwitchingActiveProfile, pendingChanges[key] == nil else { return false }
        let scope = resourceGeneration
        let change = PendingResourceChange(label: label, title: title, color: color, isMoving: isMoving)
        pendingChanges[key] = change
        actionErrorMessage = nil
        lastError = nil
        defer {
            if pendingChanges[key]?.id == change.id,
               pendingChanges[key]?.requiresRefresh != true,
               pendingChanges[key]?.snapshotClaim == nil {
                pendingChanges.removeValue(forKey: key)
            }
        }
        do {
            let result = try await operation()
            guard scope == resourceGeneration, ServerCacheGeneration.current(for: server) == cacheGeneration,
                  pendingChanges[key]?.id == change.id else { return false }
            confirmed(result)
            if awaitsSessionSnapshot {
                claimCount += 1
                pendingChanges[key]?.snapshotClaim = claimCount
            }
            if releaseAfterWrite { pendingChanges.removeValue(forKey: key) }
            let loaded = await reconcile(true)
            guard scope == resourceGeneration else { return false }
            if !loaded, !releaseAfterWrite { pendingChanges[key]?.requiresRefresh = true }
            return true
        } catch {
            guard scope == resourceGeneration, ServerCacheGeneration.current(for: server) == cacheGeneration,
                  pendingChanges[key]?.id == change.id else { return false }
            // A lost creation acknowledgement needs reconciliation before another non-idempotent attempt.
            let refused: Bool
            if let error = error as? APIError {
                switch error {
                case .unauthorized, .invalidServerURL: refused = true
                case .http(let status, _): refused = (400..<500).contains(status) && status != 408
                default: refused = false
                }
            } else { refused = error is SessionMoveWhileStreamingError }
            let loaded: Bool
            if refused || !reconcileFailure { loaded = true } else { loaded = await reconcile(false) }
            guard scope == resourceGeneration else { return false }
            if !loaded { pendingChanges[key]?.requiresRefresh = true }
            if !APIError.isCancellation(error) {
                lastError = error
                actionErrorMessage = error.localizedDescription
            }
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

/// Submitted display values, never server metadata or inputs to grouping/filtering.
public struct PendingResourceChange: Equatable {
    public let id = UUID()
    public let label: String
    public let title: String?
    public let color: String?
    var isMoving = false
    public internal(set) var requiresRefresh = false
    var snapshotClaim: Int? = nil
    public var status: String { String(localized: "Pending: \(label)") }
}
