import Foundation
import AuthenticationServices
import CryptoKit
import Observation
import OSLog
import Security
import SwiftData

private let authManagerLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
    category: "AuthManager"
)

@MainActor
@Observable
public final class AuthManager {
    public enum State: Equatable {
        case unconfigured
        case loggedOut(server: URL)
        case loggedIn(server: URL)

        /// The server this state refers to, if any — used to scope sign-out and
        /// session-expiry to the active server (#16). `unconfigured` has none.
        var server: URL? {
            switch self {
            case .unconfigured: return nil
            case .loggedOut(let server), .loggedIn(let server): return server
            }
        }
    }

    /// Shown when a server has auth on but explicitly reports password auth off,
    /// i.e. it signs in with passkeys (which we can't do yet). See issue #255.
    nonisolated static let passkeyOnlyMessage =
        String(localized: "This server signs in with passkeys, which Talaria doesn't support yet.")

    /// Single sign-on. Talaria cannot run the OIDC redirect flow yet, and an
    /// external browser's session is not shared with the app.
    nonisolated static let oidcOnlyMessage =
        String(localized: "This server signs in with single sign-on, which Talaria doesn't support yet.")

    /// The server withholds single sign-on until it can read its SSO settings.
    nonisolated static let oidcUnavailableMessage =
        String(localized: "Single sign-on is temporarily unavailable. Try again in a moment.")

    /// Trusted-header mode where the proxy did *not* authenticate this request,
    /// so the server reports the mode but not a session.
    nonisolated static let trustedAuthNotSignedInMessage =
        String(localized: "This server signs in through an identity proxy, which didn't authorize this request. Open the server in a browser, or check the custom headers.")

    /// Why the app can't complete sign-in on its own, or nil when it can —
    /// either there's no auth, the server already signed this client in, or a
    /// password login is available.
    ///
    /// Replaces the "auth on and password auth off ⇒ passkeys" inference that
    /// used to live in three places. `is_auth_enabled()` upstream
    /// (`api/auth.py:563`) also covers OIDC and trusted-header, so that
    /// inference locked out working deployments and told them the wrong reason.
    nonisolated static func unsupportedSignInMessage(for status: AuthStatusResponse) -> String? {
        guard status.authEnabled == true, !status.isAlreadySignedIn else { return nil }
        // A missing value means an older server that doesn't report it; fall
        // through to the password path rather than block a working user.
        guard status.passwordAuthEnabled == false else { return nil }

        if status.oidcEnabled == true {
            return status.oidcNativeHandoffEnabled == true ? nil : oidcOnlyMessage
        }
        if status.oidcUnavailable == true { return oidcUnavailableMessage }
        if status.trustedAuthEnabled == true { return trustedAuthNotSignedInMessage }
        return passkeyOnlyMessage
    }

    public private(set) var state: State = .unconfigured
    public private(set) var lastErrorMessage: String?
    public private(set) var pendingReauthentication: URL?
    public private(set) var authenticatedIdentityRevision = 0
    public private(set) var reauthenticationOffersSSO = false
    public private(set) var reauthenticationOffersPassword = true
    @ObservationIgnored private(set) var recoveryTask: Task<Void, Never>?
    private var recoveryID = UUID()
    private let mutationBlockID = UUID()

    deinit {
        APIClient.setReauthenticationRequired(nil, owner: mutationBlockID)
    }

    private func finishRecovery() {
        recoveryID = UUID()
        recoveryTask?.cancel()
        recoveryTask = nil
        pendingReauthentication = nil
        APIClient.setReauthenticationRequired(nil, owner: mutationBlockID)
    }

    private func requireReauthentication(for server: URL, status: AuthStatusResponse?) {
        let usedSSO = (try? keychain.load(.authenticatedProfile, scope: server.absoluteString)) != nil
        // Without a successful capability probe, keep retry/header repair available.
        reauthenticationOffersSSO = status != nil && status?.oidcEnabled != false
            && (status?.oidcNativeHandoffEnabled ?? (usedSSO && status?.oidcEnabled == nil))
        reauthenticationOffersPassword = status != nil && (status?.passwordAuthEnabled == true
            || (!reauthenticationOffersSSO && status?.passwordAuthEnabled != false))
        if let status, let guidance = Self.unsupportedSignInMessage(for: status) {
            lastErrorMessage = guidance
        }
        pendingReauthentication = server
        APIClient.setReauthenticationRequired(server, owner: mutationBlockID)
    }

    /// Observable snapshot of every configured server, mirrored from the
    /// `ServerRegistry` (the persistent source of truth) after each mutation so
    /// the Settings server list updates reactively (#17). The active server is the
    /// one whose `id` matches `state.server?.absoluteString`.
    public private(set) var servers: [ServerAccount] = []

    private let keychain: any KeychainStoring
    private let clientFactory: (URL) -> any AuthAPIClient
    /// Builds a client bound to explicit headers (not the shared `CustomHeaderStore`)
    /// — used by `addServer` to probe a new server without disturbing the active
    /// server's live headers (#17).
    private let probeClientFactory: (URL, [CustomHeader], HTTPCookieStorage) -> any AuthAPIClient
    private let webAuthenticator: (URL, String) async throws -> URL
    private let headerStore: CustomHeaderStore
    private let cookieStorageProvider: (URL) -> HTTPCookieStorage
    private let persistSessionCookies: (URL) throws -> Void
    private let clearStoredSessionCookies: (URL) -> Void
    private let fallbackCookieStorage: HTTPCookieStorage?
    private let profileEntityCache: ProfileEntityCache
    /// Drops every local store keyed by one server: the stored session
    /// selection, composer drafts, the offline session/message cache, the
    /// per-server session-row flags, and the Insights cache. Runs after the
    /// registry removal commits on sign-out and server removal (TAL-146), and
    /// before anything durable is written whenever native OIDC reconciles a
    /// different server-authorized profile than the last sign-in there; only
    /// the OIDC path lets a thrown error abort the operation (TAL-131).
    private let resetServerScopedState: @MainActor (URL) async throws -> Void
    private let logoutTimeout: Duration
    private let serverRegistry: ServerRegistry
    /// Identity edits not yet written to the registry, keyed by server id, so
    /// typing in Settings costs no Keychain write per keystroke (TAL-123).
    private var pendingIdentityEdits: [String: ServerAccount] = [:]
    private var identitySaveTask: Task<Void, Never>?
    private let identitySaveDelay: Duration
    /// Why the last identity save failed; the edit stays pending for a retry.
    public private(set) var identitySaveErrorMessage: String?
    private var isOIDCSignInActive = false
    /// Servers whose retained password already got its one automatic retry
    /// after a 401, so a stale password cannot loop.
    private var autoSignInAttempted: Set<String> = []
    /// Servers already probed by `resolveMissingPasswordMarkers` this launch.
    private var passwordProbes: Set<String> = []

    /// The Keychain refused the retained password after a successful login.
    struct PasswordRetentionError: LocalizedError {
        var errorDescription: String? {
            String(localized: "Could not save the password to the Keychain.")
        }
    }

    /// Stored as the retained password when a server authenticated without
    /// one (auth off, trusted headers, OIDC), so sync can tell "no password
    /// needed" from "never captured" (TAL-91).
    nonisolated static let noPasswordRequired = ""

    public init(
        keychain: any KeychainStoring = KeychainStore(),
        clientFactory: @escaping (URL) -> any AuthAPIClient = { APIClient(baseURL: $0) },
        probeClientFactory: @escaping (URL, [CustomHeader], HTTPCookieStorage) -> any AuthAPIClient = { url, headers, cookies in
            APIClient(baseURL: url, cookieStorage: cookies, customHeaderProvider: { headers })
        },
        webAuthenticator: @escaping (URL, String) async throws -> URL = { url, scheme in
            try await PlatformHooks.authenticateInBrowser(url, scheme)
        },
        headerStore: CustomHeaderStore = .shared,
        cookieStorage: HTTPCookieStorage? = nil,
        cookieStore: ServerCookieStore? = nil,
        profileEntityCache: ProfileEntityCache = .shared,
        resetServerScopedState: @escaping @MainActor (URL) async throws -> Void = { _ in },
        logoutTimeout: Duration = .seconds(5),
        identitySaveDelay: Duration = .milliseconds(750),
        serverRegistry: ServerRegistry = .shared
    ) {
        self.keychain = keychain
        self.clientFactory = clientFactory
        self.probeClientFactory = probeClientFactory
        self.webAuthenticator = webAuthenticator
        self.headerStore = headerStore
        if let cookieStorage {
            fallbackCookieStorage = cookieStorage
            cookieStorageProvider = { _ in cookieStorage }
            persistSessionCookies = { _ in }
            clearStoredSessionCookies = { server in
                cookieStorage.cookies(for: server)?.forEach(cookieStorage.deleteCookie)
            }
        } else {
            let resolvedCookieStore = cookieStore ?? (
                keychain is KeychainStore
                    ? .shared
                    : ServerCookieStore(
                        keychain: keychain,
                        legacyStorage: ServerCookieStore.makeIsolatedStorage()
                    )
            )
            fallbackCookieStorage = nil
            cookieStorageProvider = resolvedCookieStore.storage(for:)
            persistSessionCookies = resolvedCookieStore.persist(for:)
            clearStoredSessionCookies = resolvedCookieStore.clear(for:)
        }
        self.profileEntityCache = profileEntityCache
        self.resetServerScopedState = resetServerScopedState
        self.logoutTimeout = logoutTimeout
        self.identitySaveDelay = identitySaveDelay
        self.serverRegistry = serverRegistry
        restoreSavedServer()
        refreshServers()
    }

    /// The production `resetServerScopedState`: clears the server's stored
    /// selection, session-row flags, Insights cache, cached responses
    /// (`ResponseCache`), browsed Kanban Board, suspended-stream snapshots,
    /// composer drafts, and its offline cache in the app's SwiftData container.
    /// Draft removal is flushed to disk rather than left to the debounced
    /// write, and any failure propagates so an OIDC sign-in fails closed
    /// instead of exposing the previous profile's data.
    public static func serverScopedStateReset(
        cacheContainer: ModelContainer,
        draftStore: ChatDraftStore = .shared,
        defaults: UserDefaults = .standard,
        responseCacheRoot: URL? = nil
    ) -> @MainActor (URL) async throws -> Void {
        { server in
            // First, so a screen still open on the previous identity cannot write back what follows.
            ServerCacheGeneration.advance(for: server)
            SessionNavigationPersistence.save(nil, for: server, defaults: defaults)
            SessionRowDisplaySettings.clearServerScopedSettings(for: server, in: defaults)
            InsightsResponseCache(server: server, defaults: defaults).clear()
            ResponseCache(server: server, root: responseCacheRoot).clear()
            KanbanFeatureState.clearBrowsedBoard(for: server, in: defaults)
            ActiveChatStreamSnapshotStore.shared.removeAll(for: server)
            await draftStore.discardDrafts(for: server)
            // The two durable deletions are independent: attempt both, then
            // surface the first failure so neither store outlives the other.
            let cacheResult = Result { try CacheStore.clearCache(for: server, in: cacheContainer.mainContext) }
            try await draftStore.flush()
            try cacheResult.get()
        }
    }

    /// The active server's id (its normalized URL string), or nil when
    /// unconfigured. Used by the Settings list to mark which row is active.
    public var activeServerID: String? { state.server?.absoluteString }

    /// Re-reads the registry into the observable `servers` snapshot. Called after
    /// every registry mutation routed through this manager.
    private func refreshServers() {
        servers = serverRegistry.servers
        // A removed server's unsaved edit must never land on a later entry.
        pendingIdentityEdits = pendingIdentityEdits.filter { id, _ in servers.contains { $0.id == id } }
        notifyConfigurationChanged()
    }

    /// Tells `ConfigurationSyncCoordinator` that the server list, a password, or
    /// a header set was persisted, without this manager knowing about sync.
    private func notifyConfigurationChanged() {
        NotificationCenter.default.post(name: .talariaServerConfigurationChanged, object: nil)
    }

    /// The headers currently in effect — used to prefill the editor on the connect
    /// and Settings screens.
    public var currentCustomHeaders: [CustomHeader] {
        headerStore.snapshot()
    }

    /// Returns the request headers scoped to one configured server without
    /// changing the active server's live header snapshot.
    /// Like `customHeaders(for:)`, but nil when the Keychain read itself failed,
    /// so sync can tell "no headers" from "could not read them" (TAL-91).
    func customHeadersIfReadable(for account: ServerAccount) -> [CustomHeader]? {
        let scope = account.customHeadersRef ?? account.urlString
        do {
            return [CustomHeader].decodeFromStorage(try keychain.load(.customHeaders, scope: scope))
        } catch {
            return nil
        }
    }

    public func customHeaders(for account: ServerAccount) -> [CustomHeader] {
        if account.id == activeServerID {
            return headerStore.snapshot()
        }
        let scope = account.customHeadersRef ?? account.urlString
        let stored = try? keychain.load(.customHeaders, scope: scope)
        return [CustomHeader].decodeFromStorage(stored)
    }

    func testConnection(
        serverURLString: String,
        customHeaders: [CustomHeader]? = nil
    ) async throws -> AuthStatusResponse {
        // Apply the in-progress headers before the very first probe so the health
        // and auth-status calls already traverse the proxy. Passing nil leaves the
        // current headers untouched (#255).
        if let customHeaders {
            headerStore.replace(with: customHeaders.sanitizedForStorage())
        }

        let serverURL = try Self.normalizedServerURL(from: serverURLString)
        let client = clientFactory(serverURL)

        return try await testConnection(client: client)
    }

    private func testConnection(client: any AuthAPIClient) async throws -> AuthStatusResponse {
        let health = try await client.health()
        guard health.status == "ok" else {
            throw APIError.http(statusCode: 200, body: "Unexpected health status.")
        }

        return try await client.authStatus()
    }

    /// Returns discovered capabilities even when sign-in needs user input,
    /// so a restored setup can offer the server's actual sign-in methods.
    @discardableResult
    public func configure(
        serverURLString: String,
        password: String,
        customHeaders: [CustomHeader]? = nil,
        canCommit: @escaping @MainActor () -> Bool = { true }
    ) async -> AuthStatusResponse? {
        lastErrorMessage = nil
        let previousServerID = state.server?.absoluteString
        var discoveredStatus: AuthStatusResponse?

        if let customHeaders {
            headerStore.replace(with: customHeaders.sanitizedForStorage())
        }

        do {
            let serverURL = try Self.normalizedServerURL(from: serverURLString)
            let client = clientFactory(serverURL)
            let authStatus = try await testConnection(client: client)
            guard canCommit() else { return nil }
            discoveredStatus = authStatus
            if pendingReauthentication == serverURL {
                requireReauthentication(for: serverURL, status: authStatus)
            }

            if let message = Self.unsupportedSignInMessage(for: authStatus) {
                lastErrorMessage = message
                return authStatus
            }

            // `logged_in` means the server already authenticated this client —
            // trusted-header mode does it at the proxy — so there is nothing to
            // log in with and the server is saved as signed in.
            var retainedPassword = Self.noPasswordRequired
            if authStatus.authEnabled == true, !authStatus.isAlreadySignedIn {
                guard !password.isEmpty else {
                    if pendingReauthentication != serverURL || authStatus.oidcNativeHandoffEnabled != true {
                        lastErrorMessage = String(localized: "Enter the server password.")
                    }
                    return authStatus
                }

                let loginResponse = try await client.login(password: password)
                guard canCommit() else { return nil }
                guard loginResponse.ok == true else {
                    lastErrorMessage = APIError.unauthorized.localizedDescription
                    return authStatus
                }
                retainedPassword = password
            }

            do {
                try completeConfiguration(
                    serverURL,
                    previousServerID: previousServerID,
                    password: retainedPassword
                )
            } catch {
                _ = try? await client.logout()
                clearSessionCookies(for: serverURL)
                throw error
            }
        } catch {
            guard canCommit() else { return nil }
            lastErrorMessage = error.localizedDescription
        }
        return discoveredStatus
    }

    public func configureWithOIDC(
        serverURLString: String,
        customHeaders: [CustomHeader]? = nil,
        canCommit: @escaping @MainActor () -> Bool = { true }
    ) async {
        lastErrorMessage = nil
        guard !isOIDCSignInActive else {
            lastErrorMessage = OIDCSignInError.alreadyInProgress.localizedDescription
            return
        }
        isOIDCSignInActive = true
        defer { isOIDCSignInActive = false }

        if let customHeaders {
            headerStore.replace(with: customHeaders.sanitizedForStorage())
        }

        do {
            let serverURL = try Self.normalizedServerURL(from: serverURLString)
            let client = clientFactory(serverURL)
            let cookies = cookieStorageProvider(serverURL)
            let activeProfile = try await authenticateWithOIDC(
                client: client,
                serverURL: serverURL,
                cookieStorage: cookies
            )
            func abandonSession() async {
                _ = try? await client.logout()
                clearSessionCookies(for: serverURL)
            }
            do {
                // Checked before the destructive purge so an attempt the user
                // edited or dismissed during the browser handoff never drops
                // drafts or cache, and again after the purge's suspension
                // point so a superseded attempt can never commit.
                guard canCommit() else {
                    await abandonSession()
                    return
                }
                try await resetProfileScopedStateIfChanged(activeProfile, for: serverURL)
                guard canCommit() else {
                    await abandonSession()
                    return
                }
                try completeConfiguration(
                    serverURL,
                    previousServerID: state.server?.absoluteString,
                    authenticatedProfile: activeProfile,
                    password: Self.noPasswordRequired
                )
            } catch {
                await abandonSession()
                throw error
            }
            lastErrorMessage = nil
        } catch {
            guard canCommit() else { return }
            lastErrorMessage = Self.oidcErrorMessage(error)
        }
    }

    /// Outcome of `addServer`, so the in-app add-server flow can reveal the
    /// password field only when the server actually needs one (#17).
    public enum AddServerOutcome: Equatable {
        case added(URL)
        case needsPassword
        case needsOIDC
        case needsPasswordOrOIDC
        case failed
    }

    /// Adds (and switches to) another server from the in-app add-server flow.
    ///
    /// Unlike `configure` (the onboarding path), this NEVER mutates the active
    /// server's state or its live header store until the add fully succeeds: the
    /// new server is probed through a client bound to *its own* headers (via
    /// `probeClientFactory`), not the shared `CustomHeaderStore`. So a typo or an
    /// unreachable server can't bounce the user out of a working session, and the
    /// active server's concurrent requests (polling / SSE reconnect) never pick up
    /// the new server's headers during the async probe window. Rejects a URL that's
    /// already configured (no duplicate normalized URLs). On success the new server
    /// becomes active and its headers are persisted under its own scoped key (#16).
    @discardableResult
    public func addServer(
        serverURLString: String,
        password: String,
        customHeaders: [CustomHeader] = []
    ) async -> AddServerOutcome {
        lastErrorMessage = nil

        let serverURL: URL
        do {
            serverURL = try Self.normalizedServerURL(from: serverURLString)
        } catch {
            lastErrorMessage = error.localizedDescription
            return .failed
        }

        guard !serverRegistry.servers.contains(where: { $0.id == serverURL.absoluteString }) else {
            lastErrorMessage = String(localized: "This server is already configured.")
            return .failed
        }

        let newHeaders = customHeaders.sanitizedForStorage()
        // Probe with a client scoped to the NEW server's headers, leaving the live
        // header store (and the active server's in-flight/SSE requests) untouched.
        let probeCookies = ServerCookieStore.makeIsolatedStorage()
        let client = probeClientFactory(serverURL, newHeaders, probeCookies)

        do {
            let authStatus = try await testConnection(client: client)

            if let message = Self.unsupportedSignInMessage(for: authStatus) {
                lastErrorMessage = message
                return .failed
            }

            var retainedPassword = Self.noPasswordRequired
            if authStatus.authEnabled == true, !authStatus.isAlreadySignedIn {
                guard !password.isEmpty else {
                    let oidcAvailable = authStatus.oidcEnabled == true
                        && authStatus.oidcNativeHandoffEnabled == true
                    if oidcAvailable {
                        return authStatus.passwordAuthEnabled == true
                            ? .needsPasswordOrOIDC
                            : .needsOIDC
                    }
                    return .needsPassword
                }

                let loginResponse = try await client.login(password: password)
                guard loginResponse.ok == true else {
                    lastErrorMessage = APIError.unauthorized.localizedDescription
                    return .failed
                }
                retainedPassword = password
            }

            try completeAddedServer(
                serverURL,
                headers: newHeaders,
                cookies: probeCookies.cookies(for: serverURL) ?? [],
                password: retainedPassword
            )
            probeCookies.cookies?.forEach(probeCookies.deleteCookie)
            return .added(serverURL)
        } catch {
            probeCookies.cookies?.forEach(probeCookies.deleteCookie)
            lastErrorMessage = error.localizedDescription
            return .failed
        }
    }

    @discardableResult
    public func addServerWithOIDC(
        serverURLString: String,
        customHeaders: [CustomHeader] = []
    ) async -> AddServerOutcome {
        lastErrorMessage = nil
        guard !isOIDCSignInActive else {
            lastErrorMessage = OIDCSignInError.alreadyInProgress.localizedDescription
            return .failed
        }
        isOIDCSignInActive = true
        defer { isOIDCSignInActive = false }

        do {
            let serverURL = try Self.normalizedServerURL(from: serverURLString)
            guard !serverRegistry.servers.contains(where: { $0.id == serverURL.absoluteString }) else {
                throw OIDCSignInError.alreadyConfigured
            }

            let newHeaders = customHeaders.sanitizedForStorage()
            let probeCookies = ServerCookieStore.makeIsolatedStorage()
            let client = probeClientFactory(serverURL, newHeaders, probeCookies)
            let activeProfile = try await authenticateWithOIDC(
                client: client,
                serverURL: serverURL,
                cookieStorage: probeCookies
            )
            do {
                try await resetProfileScopedStateIfChanged(activeProfile, for: serverURL)
                try completeAddedServer(
                    serverURL,
                    headers: newHeaders,
                    cookies: probeCookies.cookies(for: serverURL) ?? [],
                    authenticatedProfile: activeProfile,
                    password: Self.noPasswordRequired
                )
                probeCookies.cookies?.forEach(probeCookies.deleteCookie)
            } catch {
                _ = try? await client.logout()
                probeCookies.cookies?.forEach(probeCookies.deleteCookie)
                throw error
            }
            return .added(serverURL)
        } catch {
            lastErrorMessage = Self.oidcErrorMessage(error)
            return .failed
        }
    }

    /// Runs the native OIDC handoff and returns the profile the server bound the
    /// new session to. A failed exchange or profile check logs the partial
    /// session out. Cancellation before exchange preserves the existing cookies.
    private func authenticateWithOIDC(
        client: any AuthAPIClient,
        serverURL: URL,
        cookieStorage: HTTPCookieStorage
    ) async throws -> String {
        var startedFlow: (id: String, state: String)?
        var attemptedExchange = false
        do {
            let status = try await testConnection(client: client)
            guard status.oidcEnabled == true else { throw OIDCSignInError.unavailable }
            guard status.oidcNativeHandoffEnabled == true else {
                throw OIDCSignInError.incompatibleServer
            }
            guard !status.isAlreadySignedIn else { throw OIDCSignInError.unavailable }

            let callbackScheme = TalariaDeepLink.scheme
            var flow = try NativeOIDCFlow.make(callbackScheme: callbackScheme)
            let start = try await client.beginNativeOIDC(
                callbackURL: flow.callbackURL,
                state: flow.state,
                codeChallenge: flow.codeChallenge
            )
            startedFlow = (start.flowId, flow.state)
            guard start.expiresIn > 0 else { throw OIDCSignInError.expired }
            let expiresAt = Date().addingTimeInterval(TimeInterval(start.expiresIn))
            guard APIClient.isSameOrigin(start.authorizationUrl, as: serverURL) else {
                throw OIDCSignInError.invalidAuthorizationURL
            }

            let callback = try await webAuthenticator(start.authorizationUrl, callbackScheme)
            let code = try flow.exchangeCode(
                from: callback,
                expectedFlowID: start.flowId,
                expectedServerID: start.serverId,
                expiresAt: expiresAt
            )
            attemptedExchange = true
            let response = try await client.exchangeNativeOIDC(
                flowID: start.flowId,
                code: code,
                state: flow.state,
                codeVerifier: flow.codeVerifier
            )
            guard response.ok == true else { throw APIError.unauthorized }
            guard try await client.authStatus().isAlreadySignedIn else {
                throw APIError.unauthorized
            }
            startedFlow = nil
            // The server binds an OIDC session to a mapped profile; adopt exactly
            // that before anything is committed, never a local default or cached
            // selection (TAL-131). This response may also set `hermes_profile`,
            // so callers persist cookies only after it returns.
            return try Self.authorizedProfileName(from: try await client.profiles())
        } catch {
            if let startedFlow {
                _ = try? await client.cancelNativeOIDC(
                    flowID: startedFlow.id,
                    state: startedFlow.state
                )
            }
            if attemptedExchange {
                _ = try? await client.logout()
                cookieStorage.cookies?.forEach(cookieStorage.deleteCookie)
            }
            throw error
        }
    }

    /// The `active` profile from `GET /api/profiles`, accepted only when it is a
    /// non-blank name that also appears in the response's profile list.
    nonisolated static func authorizedProfileName(from response: ProfilesResponse) throws -> String {
        guard let active = response.active?.trimmingCharacters(in: .whitespacesAndNewlines),
              !active.isEmpty,
              response.profiles?.contains(where: { $0.normalizedName == active }) == true
        else {
            throw OIDCSignInError.profileUnavailable
        }
        return active
    }

    /// When `profile` differs from the last sign-in on `server`, drops every
    /// profile-scoped local artifact before anything durable is written: the
    /// offline cache, stored selection, and drafts (via
    /// `resetServerScopedState`), the App Intents profile picker cache, and the
    /// quota widget snapshot (TAL-131). A purge failure propagates so the caller
    /// aborts the sign-in; the old marker stays, so the next sign-in retries.
    private func resetProfileScopedStateIfChanged(_ profile: String, for server: URL) async throws {
        let scope = server.absoluteString
        guard (try? keychain.load(.authenticatedProfile, scope: scope)) != profile else { return }
        try await resetServerScopedState(server)
        // A different SSO identity must also lose the old views' in-memory data.
        // Same-profile recovery preserves navigation and composer state.
        if pendingReauthentication == server { authenticatedIdentityRevision += 1 }
        profileEntityCache.save([])
        clearQuotaWidgetSnapshot()
    }

    /// Records the server-authorized profile for `server`. A sign-in without a
    /// reconciled profile (password) forgets the marker, so the next OIDC
    /// sign-in cannot mistake that session's cache for its own. A failed write
    /// aborts the commit: a stale marker would let a later sign-in as the old
    /// profile skip its purge (TAL-134).
    private func recordAuthenticatedProfile(_ profile: String?, for server: URL) throws {
        let scope = server.absoluteString
        if let profile {
            try keychain.save(profile, forKey: .authenticatedProfile, scope: scope)
        } else {
            try keychain.delete(.authenticatedProfile, scope: scope)
        }
    }

    private func completeAddedServer(
        _ serverURL: URL,
        headers: [CustomHeader],
        cookies: [HTTPCookie],
        authenticatedProfile: String? = nil,
        password: String
    ) throws {
        // The only throwing mutation happens first, while the old active server
        // and its cookie jar are still untouched.
        let targetStorage = cookieStorageProvider(serverURL)
        targetStorage.cookies?.forEach(targetStorage.deleteCookie)
        cookies.forEach(targetStorage.setCookie)
        let previousPassword = serverPassword(for: serverURL.absoluteString)
        do {
            try persistSessionCookies(serverURL)
            // Retained before the registry row exists: a server that cannot keep
            // its password would sync without one and never sign in again.
            guard persistServerPassword(password, for: serverURL) else {
                throw PasswordRetentionError()
            }
            try recordAuthenticatedProfile(authenticatedProfile, for: serverURL)
            try serverRegistry.activate(url: serverURL)
        } catch {
            clearStoredSessionCookies(serverURL)
            restoreServerPassword(previousPassword, for: serverURL)
            // The purge may already have run: forget the marker so the next
            // sign-in purges again rather than trusting this server's cache.
            try? recordAuthenticatedProfile(nil, for: serverURL)
            throw error
        }
        try? keychain.save(serverURL.absoluteString, forKey: .serverURL)
        headerStore.replace(with: headers)
        persistCustomHeaders(for: serverURL)
        refreshServers()
        clearQuotaWidgetSnapshot()
        finishRecovery()
        state = .loggedIn(server: serverURL)
    }

    private func completeConfiguration(
        _ serverURL: URL,
        previousServerID: String?,
        authenticatedProfile: String? = nil,
        password: String
    ) throws {
        // Nothing durable is written until authentication has completed.
        try persistSessionCookies(serverURL)
        let previousPassword = serverPassword(for: serverURL.absoluteString)
        guard persistServerPassword(password, for: serverURL) else {
            throw PasswordRetentionError()
        }
        do {
            try recordAuthenticatedProfile(authenticatedProfile, for: serverURL)
            try serverRegistry.activate(url: serverURL)
        } catch {
            // Never leave a password stored for a server that was not registered.
            restoreServerPassword(previousPassword, for: serverURL)
            // The purge may already have run: forget the marker so the next
            // sign-in purges again rather than trusting this server's cache.
            try? recordAuthenticatedProfile(nil, for: serverURL)
            throw error
        }
        try? keychain.save(serverURL.absoluteString, forKey: .serverURL)
        persistCustomHeaders(for: serverURL)
        refreshServers()
        if previousServerID != serverURL.absoluteString {
            clearQuotaWidgetSnapshot()
        }
        state = .loggedIn(server: serverURL)
        finishRecovery()
        NotificationCenter.default.post(name: .talariaReauthenticated, object: serverURL)
    }

    private nonisolated static func oidcErrorMessage(_ error: Error) -> String {
        if let webError = error as? ASWebAuthenticationSessionError,
           webError.code == .canceledLogin {
            return OIDCSignInError.cancelled.localizedDescription
        }
        return error.localizedDescription
    }

    /// Updates the in-effect headers from the Settings editor while signed in. The
    /// in-memory snapshot always updates immediately (so live requests pick them
    /// up), but the Keychain write is opt-in: the editor refreshes on every
    /// keystroke (`persist: false`, cheap) and persists once on dismiss
    /// (`persist: true`), since Keychain writes are slow enough to stutter typing
    /// (#255).
    public func updateCustomHeaders(_ headers: [CustomHeader], persist: Bool = true) {
        headerStore.replace(with: headers.sanitizedForStorage())
        // Persist under the active server's scoped key. The Settings editor is only
        // reachable while signed in, so a server is always present here; if somehow
        // unconfigured there's nothing to scope to, so we skip the write (#16).
        if persist, let server = state.server {
            persistCustomHeaders(for: server)
            notifyConfigurationChanged()
        }
    }

    /// Signs out of the **active** server: best-effort server-side logout, then
    /// drops it locally and auto-switches to the next remaining server — returning
    /// to onboarding only when none remain (#17). A single-server install behaves
    /// exactly as before (sign out → onboarding).
    public func signOut() async {
        guard let active = state.server else {
            // Defensive: nothing is active. Safe full reset to onboarding.
            clearLocalAuth(for: nil)
            state = .unconfigured
            return
        }

        if case .loggedIn = state {
            await attemptBestEffortServerLogout(server: active)
        }

        do {
            try await advanceAfterRemoving(activeServer: active)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    /// Removes a configured server. When it's the active one this behaves like
    /// `signOut` (best-effort server logout + auto-switch / onboarding). A
    /// non-active server is just dropped locally — its registry row, scoped
    /// headers, cookies, and server-scoped stores — leaving the active server
    /// untouched (#17).
    @discardableResult
    public func removeServer(_ account: ServerAccount, shouldContinue: () -> Bool = { true }) async -> Bool {
        guard let serverURL = URL(string: account.urlString) else { return false }
        let isActive = state.server?.absoluteString == account.id

        do {
            if isActive {
                if case .loggedIn = state {
                    await attemptBestEffortServerLogout(server: serverURL)
                }
                // The logout suspended; a sync removal re-checks that sync is
                // still on before anything local is dropped (TAL-91).
                guard shouldContinue() else { return false }
                try await advanceAfterRemoving(activeServer: serverURL)
            } else {
                try serverRegistry.remove(id: account.id)
                clearLocalArtifacts(for: serverURL)
                refreshServers()
                await purgeServerScopedState(for: serverURL)
            }
            return true
        } catch {
            lastErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Switches the active server to an already-registered one (the Settings
    /// switcher). Mirrors the cold-launch path: persist the URL, set it active,
    /// hydrate its scoped headers, and optimistically enter `.loggedIn`. A stale
    /// cookie triggers in-place recovery after a confirmed 401, as on relaunch.
    public func switchActiveServer(to account: ServerAccount) {
        guard account.id != state.server?.absoluteString,
              let serverURL = URL(string: account.urlString) else { return }

        do {
            try serverRegistry.setActive(id: account.id)
        } catch {
            lastErrorMessage = error.localizedDescription
            return
        }
        try? keychain.save(serverURL.absoluteString, forKey: .serverURL)
        refreshServers()
        hydrateCustomHeaders(for: serverURL)
        // Drop the App Intents profile picker cache (#339): it holds the previous server's
        // profiles, which would leak into Shortcuts / Siri if the new server's fetch is
        // delayed or fails. The new server's profiles reload on the next foreground fetch.
        profileEntityCache.save([])
        clearQuotaWidgetSnapshot()
        lastErrorMessage = nil
        finishRecovery()
        state = .loggedIn(server: serverURL)
    }

    /// Stages a server's per-server identity (display name, initials, Header
    /// Logo Color) and saves it once edits pause for `identitySaveDelay`, or on
    /// `flushServerIdentityEdits()`. The active server's identity is mirrored into
    /// the global identity defaults right away, so the avatar / header tint
    /// preview every keystroke without a Keychain write (#17, TAL-123).
    public func updateServerIdentity(
        _ account: ServerAccount,
        displayName: String,
        initials: String,
        headerLogoColorHex: String
    ) {
        var edit = account
        edit.displayName = displayName
        edit.initials = initials
        edit.headerLogoColorHex = headerLogoColorHex
        pendingIdentityEdits[account.id] = edit
        serverRegistry.mirrorIdentityIfActive(edit)
        identitySaveTask?.cancel()
        identitySaveTask = Task { [weak self, identitySaveDelay] in
            try? await Task.sleep(for: identitySaveDelay)
            guard !Task.isCancelled else { return }
            self?.flushServerIdentityEdits()
        }
    }

    /// Writes every staged identity edit to the registry now. Returns false when
    /// a write fails; that edit stays staged and `identitySaveErrorMessage`
    /// explains the failure until a later flush succeeds.
    @discardableResult
    public func flushServerIdentityEdits() -> Bool {
        identitySaveTask?.cancel()
        identitySaveTask = nil
        guard !pendingIdentityEdits.isEmpty else {
            identitySaveErrorMessage = nil
            return true
        }
        var failure: Error?
        for (id, edit) in pendingIdentityEdits {
            // Apply only the identity onto the current entry, so a sync that
            // landed meanwhile keeps its other fields.
            guard var updated = serverRegistry.servers.first(where: { $0.id == id }) else { continue }
            updated.displayName = edit.displayName
            updated.initials = edit.initials
            updated.headerLogoColorHex = edit.headerLogoColorHex
            do {
                try serverRegistry.update(updated)
                pendingIdentityEdits[id] = nil
            } catch {
                failure = error
            }
        }
        identitySaveErrorMessage = failure?.localizedDescription
        refreshServers()
        return failure == nil
    }

    /// Drops the active server locally + from the registry, then auto-switches to
    /// the next remaining server, or returns to onboarding when none remain. The
    /// shared core of `signOut` and active-server `removeServer` (#17).
    private func advanceAfterRemoving(activeServer server: URL) async throws {
        let nextActive = try serverRegistry.remove(id: server.absoluteString)
        finishRecovery()

        // Always drop any pre-#16 global header remnant on a sign-out path.
        try? keychain.delete(.customHeaders)
        clearLocalArtifacts(for: server)
        // Drop the App Intents profile picker cache (#339): the cached profiles belong to the
        // server being removed, so they're stale whether we switch to another server (its
        // profiles reload on the next foreground fetch) or return to onboarding.
        profileEntityCache.save([])
        clearQuotaWidgetSnapshot()

        refreshServers()

        if let nextActive, let nextURL = URL(string: nextActive.urlString) {
            try? keychain.save(nextURL.absoluteString, forKey: .serverURL)
            hydrateCustomHeaders(for: nextURL)
            lastErrorMessage = nil
            state = .loggedIn(server: nextURL)
        } else {
            try? keychain.delete(.serverURL)
            headerStore.replace(with: [])
            state = .unconfigured
        }
        await purgeServerScopedState(for: server)
    }

    /// Drops a removed server's drafts, selection, cache, and per-server
    /// defaults once its registry row is gone. Best-effort: every store is
    /// server-keyed, so a leftover cannot surface under another server, and
    /// undoing the removal would be worse than the leftover (TAL-146).
    private func purgeServerScopedState(for server: URL) async {
        do {
            try await resetServerScopedState(server)
        } catch {
            authManagerLogger.warning(
                "Failed to purge local state for removed server: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    /// Deletes one server's local auth artifacts — its scoped custom headers and
    /// its cookies — without touching the registry or the global `server_url` key.
    private func clearLocalArtifacts(for server: URL) {
        try? keychain.delete(.customHeaders, scope: server.absoluteString)
        try? keychain.delete(.authenticatedProfile, scope: server.absoluteString)
        try? keychain.delete(.serverPassword, scope: server.absoluteString)
        clearSessionCookies(for: server)
    }

    private func clearQuotaWidgetSnapshot() {
        _ = ProviderQuotaWidgetRefreshCredentialStore.clear()
        guard ProviderQuotaWidgetSnapshotStore().clear() else { return }
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
    }

    /// Tells the server to end the session, but never lets an unreachable or
    /// slow server block local sign-out. The request is best-effort and bounded
    /// by `logoutTimeout`; on failure, timeout, or cancellation we just move on
    /// so the caller can always clear local auth and return to onboarding.
    ///
    /// Order matters: this runs while the session cookie still exists, so a
    /// reachable server is logged out server-side before `clearLocalAuth()`
    /// deletes the cookie. See issue #249.
    private func attemptBestEffortServerLogout(server: URL) async {
        let client = clientFactory(server)
        // Copy to a local so the timeout task captures only the value, not `self`.
        let timeout = logoutTimeout

        let logoutTask = Task { @MainActor in
            _ = try await client.logout()
        }
        let timeoutTask = Task { @MainActor in
            try? await Task.sleep(for: timeout)
            logoutTask.cancel()
        }

        _ = try? await logoutTask.value
        timeoutTask.cancel()
    }

    public func handleAPIError(_ error: Error, server sourceServer: URL? = nil) {
        guard case APIError.unauthorized = error,
              case .loggedIn(let server) = state,
              sourceServer == nil || sourceServer == server,
              pendingReauthentication == nil, recoveryTask == nil else { return }

        let id = UUID()
        recoveryID = id
        let client = probeClientFactory(server, currentCustomHeaders, cookieStorageProvider(server))
        recoveryTask = Task { [weak self] in
            guard let self, recoveryID == id, state == .loggedIn(server: server) else { return }
            defer { if recoveryID == id { recoveryTask = nil } }
            let status: AuthStatusResponse?
            do {
                status = try await client.authStatus()
                guard status?.loggedIn == false else { return }
            } catch APIError.unauthorized {
                status = nil
            } catch {
                // An offline or malformed probe cannot establish session loss.
                return
            }
            guard recoveryID == id, state == .loggedIn(server: server) else { return }
            APIClient.setReauthenticationRequired(server, owner: mutationBlockID)
            let usedSSO = (try? keychain.load(.authenticatedProfile, scope: server.absoluteString)) != nil
            if !usedSSO, status?.passwordAuthEnabled != false,
               let password = serverPassword(for: server.absoluteString), !password.isEmpty,
               autoSignInAttempted.insert(server.absoluteString).inserted {
                if await signInWithStoredPassword(serverID: server.absoluteString, canCommit: {
                    self.recoveryID == id && self.state == .loggedIn(server: server)
                }) { return }
            }
            guard recoveryID == id, state == .loggedIn(server: server) else { return }
            lastErrorMessage = nil
            _ = ProviderQuotaWidgetRefreshCredentialStore.clear()
            requireReauthentication(for: server, status: status)
        }
    }

    /// Clears local auth for `server` (a full per-server sign-out): forgets that
    /// server's saved URL, its scoped custom headers, and its cookies, leaving any
    /// other configured server untouched (#16).
    ///
    /// When `server` is nil there's no active server to
    /// scope to, so we fall back to clearing the global remnants and the whole
    /// cookie jar as a safe reset.
    private func clearLocalAuth(for server: URL?) {
        // The legacy single-server URL key is global; always clear it on sign-out.
        try? keychain.delete(.serverURL)
        // Drop any pre-#16 global header blob too, so it can't linger or be
        // re-migrated after the user has signed out.
        try? keychain.delete(.customHeaders)

        if let server {
            try? keychain.delete(.customHeaders, scope: server.absoluteString)
            try? keychain.delete(.authenticatedProfile, scope: server.absoluteString)
            try? keychain.delete(.serverPassword, scope: server.absoluteString)
            clearSessionCookies(for: server)
        } else {
            clearAllSessionCookies()
        }

        // Forget the active server in the registry (leaves other servers intact).
        do {
            try serverRegistry.forgetActiveServer()
        } catch {
            lastErrorMessage = error.localizedDescription
            return
        }
        refreshServers()
        headerStore.replace(with: [])
        // Drop the App Intents profile picker cache (#339) so a signed-out user doesn't see
        // the previous server's profiles lingering in Shortcuts / Siri.
        profileEntityCache.save([])
        clearQuotaWidgetSnapshot()
    }

    // MARK: - Retained passwords and iCloud sync (TAL-91)

    /// The password retained for `serverID` after its last successful sign-in:
    /// nil when never captured, `noPasswordRequired` when the server needs none.
    public func serverPassword(for serverID: String) -> String? {
        try? keychain.load(.serverPassword, scope: serverID)
    }

    /// Throwing variant for sync: a failed Keychain read must never be taken
    /// for an absent password, which would erase the synced credential.
    func serverPasswordReadingKeychain(for serverID: String) throws -> String? {
        try keychain.load(.serverPassword, scope: serverID)
    }

    @discardableResult
    private func persistServerPassword(_ password: String, for server: URL) -> Bool {
        (try? keychain.save(password, forKey: .serverPassword, scope: server.absoluteString)) != nil
    }

    /// Servers signed in before passwords were retained carry no marker. Work
    /// out which of them never needed one so sync does not ask: a server this
    /// device signed in to with SSO (TAL-131 marker), one with auth off, a
    /// trusted-header proxy, or one whose password login is disabled. Each
    /// server is probed at most once per launch; a password-only server stays
    /// unresolved until its next login or a manual entry.
    func resolveMissingPasswordMarkers() async {
        var changed = false
        for account in serverRegistry.servers
        where serverPassword(for: account.id) == nil && !passwordProbes.contains(account.id) {
            passwordProbes.insert(account.id)
            guard let serverURL = URL(string: account.urlString) else { continue }
            if (try? keychain.load(.authenticatedProfile, scope: account.id)) != nil {
                changed = persistServerPassword(Self.noPasswordRequired, for: serverURL) || changed
                continue
            }
            let probeCookies = ServerCookieStore.makeIsolatedStorage()
            let client = probeClientFactory(serverURL, customHeaders(for: account), probeCookies)
            defer { probeCookies.cookies?.forEach(probeCookies.deleteCookie) }
            guard let status = try? await testConnection(client: client) else { continue }
            if status.authEnabled != true || status.isAlreadySignedIn || status.passwordAuthEnabled == false {
                changed = persistServerPassword(Self.noPasswordRequired, for: serverURL) || changed
            }
        }
        if changed {
            notifyConfigurationChanged()
        }
    }

    /// Puts back the password that existed before a failed configuration, or
    /// removes the one just written when there was none.
    private func restoreServerPassword(_ previous: String?, for server: URL) {
        if let previous {
            try? keychain.save(previous, forKey: .serverPassword, scope: server.absoluteString)
        } else {
            try? keychain.delete(.serverPassword, scope: server.absoluteString)
        }
    }

    /// Checks `password` against `account` with a client scoped to that
    /// server's headers and an isolated cookie jar, then retains it. A server
    /// that turns out to need no password is recorded as such. Nothing about
    /// the active server changes.
    public func verifyAndStorePassword(for account: ServerAccount, password: String) async -> Bool {
        lastErrorMessage = nil
        guard let serverURL = URL(string: account.urlString) else { return false }
        let probeCookies = ServerCookieStore.makeIsolatedStorage()
        let client = probeClientFactory(serverURL, customHeaders(for: account), probeCookies)
        defer { probeCookies.cookies?.forEach(probeCookies.deleteCookie) }
        do {
            let authStatus = try await testConnection(client: client)
            var retained = Self.noPasswordRequired
            if authStatus.authEnabled == true, !authStatus.isAlreadySignedIn {
                guard !password.isEmpty else {
                    lastErrorMessage = String(localized: "Enter the server password.")
                    return false
                }
                guard try await client.login(password: password).ok == true else {
                    lastErrorMessage = APIError.unauthorized.localizedDescription
                    return false
                }
                _ = try? await client.logout()
                retained = password
            }
            guard persistServerPassword(retained, for: serverURL) else {
                lastErrorMessage = String(localized: "Could not save the password to the Keychain.")
                return false
            }
            notifyConfigurationChanged()
            return true
        } catch {
            lastErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Signs in to a configured server with its retained password and headers,
    /// obtaining a fresh WebUI session rather than copying cookie state. When
    /// that fails from an unconfigured state, open the configured server with
    /// an in-place sign-in prompt.
    @discardableResult
    func signInWithStoredPassword(
        serverID: String,
        canCommit: @escaping @MainActor () -> Bool = { true }
    ) async -> Bool {
        guard let account = serverRegistry.servers.first(where: { $0.id == serverID }),
              let serverURL = URL(string: account.urlString) else { return false }
        let wasUnconfigured = state == .unconfigured
        let authStatus = await configure(
            serverURLString: account.urlString,
            password: serverPassword(for: serverID) ?? "",
            customHeaders: customHeaders(for: account),
            canCommit: canCommit
        )
        if lastErrorMessage == nil, state == .loggedIn(server: serverURL) {
            return true
        }
        guard canCommit() else { return false }
        if wasUnconfigured {
            try? serverRegistry.setActive(id: serverID)
            try? keychain.save(serverURL.absoluteString, forKey: .serverURL)
            hydrateCustomHeaders(for: serverURL)
            refreshServers()
            state = .loggedIn(server: serverURL)
            if authStatus?.oidcNativeHandoffEnabled == true,
               serverPassword(for: serverID)?.isEmpty != false {
                lastErrorMessage = nil
            }
            requireReauthentication(for: serverURL, status: authStatus)
        }
        return false
    }

    /// Applies what CloudKit reported: upserts `setups` (identity, headers,
    /// password), removes `removing`, and restores `order`. On a device with no
    /// active server the first restored server is signed in with its retained
    /// password, so a second device opens ready to use. Returns false when a
    /// registry write failed, so the caller must not record the download as
    /// applied.
    @discardableResult
    func applySyncedServers(
        _ setups: [SyncedServerSetup],
        removing removedIDs: [String],
        order: [String],
        shouldContinue: () -> Bool = { true }
    ) async -> Bool {
        // Everything mutated so far in this batch, so any failure restores the
        // whole batch rather than leaving earlier servers half-synced.
        var rollbacks: [(id: String, previous: ServerAccount?, headers: String?, password: String?)] = []
        let originalOrder = serverRegistry.servers.map(\.id)
        func rollBackBatch() {
            for entry in rollbacks.reversed() {
                rollBackSyncedServer(id: entry.id, to: entry.previous, headers: entry.headers, password: entry.password)
            }
            try? serverRegistry.reorder(ids: originalOrder)
            // The active server's headers may already have been rehydrated from
            // the downloaded copy; put the restored Keychain value back in use.
            if let server = state.server {
                hydrateCustomHeaders(for: server)
            }
            refreshServers()
        }
        // Removals go first: a removed server cannot be recreated with its
        // purged local state, so nothing else may have been mutated when a
        // removal fails or sync is turned off during its logout suspension.
        for id in removedIDs {
            guard shouldContinue() else { return false }
            guard let account = serverRegistry.servers.first(where: { $0.id == id }) else { continue }
            if await !removeServer(account, shouldContinue: shouldContinue) {
                return false
            }
        }
        for setup in setups {
            guard shouldContinue() else {
                rollBackBatch()
                return false
            }
            guard let serverURL = URL(string: setup.urlString) else {
                rollBackBatch()
                return false
            }
            let existing = serverRegistry.servers.first { $0.id == setup.serverID }
            let previousHeaders = try? keychain.load(.customHeaders, scope: existing?.customHeadersRef ?? setup.serverID)
            let previousPassword = serverPassword(for: setup.serverID)
            rollbacks.append((setup.serverID, existing, previousHeaders, previousPassword))
            let account = ServerAccount(
                id: setup.serverID,
                urlString: setup.urlString,
                displayName: setup.displayName,
                initials: setup.initials,
                headerLogoColorHex: setup.headerLogoColorHex,
                customHeadersRef: existing?.customHeadersRef ?? setup.serverID,
                createdAt: existing?.createdAt ?? setup.updatedAt,
                updatedAt: setup.updatedAt
            )
            do {
                try serverRegistry.upsert(account)
            } catch {
                lastErrorMessage = error.localizedDescription
                rollBackBatch()
                return false
            }
            let scope = account.customHeadersRef ?? account.urlString
            var serverApplied = true
            do {
                if let encoded = setup.customHeaders.encodedForStorage() {
                    try keychain.save(encoded, forKey: .customHeaders, scope: scope)
                } else {
                    try keychain.delete(.customHeaders, scope: scope)
                }
            } catch {
                lastErrorMessage = error.localizedDescription
                serverApplied = false
            }
            if serverApplied, let password = setup.password, !persistServerPassword(password, for: serverURL) {
                lastErrorMessage = String(localized: "Could not save the password to the Keychain.")
                serverApplied = false
            }
            if !serverApplied {
                // Never leave a half-applied setup that the next pass would read
                // as a local edit and upload over the valid CloudKit copy.
                rollBackBatch()
                return false
            }
            if state.server?.absoluteString == setup.serverID {
                hydrateCustomHeaders(for: serverURL)
            }
        }
        do {
            try serverRegistry.reorder(ids: order)
        } catch {
            lastErrorMessage = error.localizedDescription
            rollBackBatch()
            return false
        }
        refreshServers()
        if state == .unconfigured, shouldContinue(), let first = serverRegistry.servers.first {
            await signInWithStoredPassword(serverID: first.id)
        }
        return true
    }

    /// Best-effort restore of one server after a failed remote application:
    /// the previous registry row, headers, and password, or nothing at all when
    /// the server was new.
    private func rollBackSyncedServer(id: String, to previous: ServerAccount?, headers: String?, password: String?) {
        if let previous {
            try? serverRegistry.upsert(previous)
        } else {
            try? serverRegistry.remove(id: id)
        }
        if let headers {
            try? keychain.save(headers, forKey: .customHeaders, scope: id)
        } else {
            try? keychain.delete(.customHeaders, scope: id)
        }
        if let password {
            try? keychain.save(password, forKey: .serverPassword, scope: id)
        } else {
            try? keychain.delete(.serverPassword, scope: id)
        }
    }

    /// Mirrors the in-memory header snapshot to `server`'s scoped Keychain entry:
    /// writes it when non-empty, deletes it when empty so no stale list lingers for
    /// that server (#16).
    private func persistCustomHeaders(for server: URL) {
        let scope = server.absoluteString
        let headers = headerStore.snapshot()
        if let encoded = headers.encodedForStorage() {
            try? keychain.save(encoded, forKey: .customHeaders, scope: scope)
        } else {
            try? keychain.delete(.customHeaders, scope: scope)
        }
    }

    /// Loads `server`'s custom headers into the live snapshot before any client is
    /// built, so the first request after launch already carries them (#255). On the
    /// first launch after the per-server split there's no scoped entry yet, so we
    /// migrate the pre-#16 global blob in place — write it under the scoped key and
    /// drop the global remnant — and use it. One scoped Keychain read on the
    /// steady-state path (#16).
    private func hydrateCustomHeaders(for server: URL) {
        let scope = server.absoluteString
        let stored: String?
        if let scoped = try? keychain.load(.customHeaders, scope: scope) {
            stored = scoped
        } else if let legacy = try? keychain.load(.customHeaders) {
            try? keychain.save(legacy, forKey: .customHeaders, scope: scope)
            try? keychain.delete(.customHeaders)
            stored = legacy
        } else {
            stored = nil
        }
        headerStore.replace(with: [CustomHeader].decodeFromStorage(stored))
    }

    /// Clears one exact server's independent cookie jar and persisted snapshot.
    /// Cookie identity includes the normalized scheme/host/port server URL, so a
    /// sibling server on another port remains untouched.
    private func clearSessionCookies(for server: URL) {
        clearStoredSessionCookies(server)
    }

    /// Clears the entire configured cookie jar. Used only as a fallback when there's no
    /// active server to scope sign-out to.
    private func clearAllSessionCookies() {
        for account in serverRegistry.servers {
            if let server = URL(string: account.urlString) {
                clearStoredSessionCookies(server)
            }
        }
        fallbackCookieStorage?.cookies?.forEach { fallbackCookieStorage?.deleteCookie($0) }
    }

    private func restoreSavedServer() {
        let savedURL: URL
        if let active = serverRegistry.activeServer,
           let activeURL = URL(string: active.urlString) {
            savedURL = activeURL
            serverRegistry.mirrorIdentityIfActive(active)
        } else {
            guard
                let savedValue = try? keychain.load(.serverURL),
                let legacyURL = URL(string: savedValue)
            else {
                // No saved server: nothing is active, so no scoped headers apply.
                state = .unconfigured
                return
            }

            // One-time migration of the legacy single-server key into the registry.
            do {
                try serverRegistry.activate(url: legacyURL)
            } catch {
                lastErrorMessage = error.localizedDescription
                state = .unconfigured
                return
            }
            savedURL = legacyURL
        }
        // Hydrate this server's headers (migrating the pre-#16 global blob on the
        // first launch after the split) before any client is built, so the first
        // request after launch carries the saved headers (#255/#16).
        hydrateCustomHeaders(for: savedURL)
        state = .loggedIn(server: savedURL)
    }

    public nonisolated static func normalizedServerURL(from rawValue: String) throws -> URL {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw APIError.invalidServerURL
        }

        let valueWithScheme = trimmed.contains("://") ? trimmed : "\(defaultScheme(forSchemalessServer: trimmed))://\(trimmed)"
        guard var components = URLComponents(string: valueWithScheme), components.host != nil else {
            throw APIError.invalidServerURL
        }

        components.host = normalizedHost(components.host)
        components.path = ""
        components.query = nil
        components.fragment = nil

        guard let url = components.url, url.scheme == "https" || url.scheme == "http" else {
            throw APIError.invalidServerURL
        }

        return url
    }

    private nonisolated static func normalizedHost(_ host: String?) -> String? {
        guard let host else { return nil }

        let lowercasedHost = host.lowercased()
        guard lowercasedHost.hasPrefix("www.webui.") else {
            return host
        }

        return String(host.dropFirst(4))
    }

    private nonisolated static func defaultScheme(forSchemalessServer rawValue: String) -> String {
        guard
            let host = URLComponents(string: "http://\(rawValue)")?.host?.lowercased(),
            shouldDefaultToPlainHTTP(host: host)
        else {
            return "https"
        }

        return "http"
    }

    private nonisolated static func shouldDefaultToPlainHTTP(host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" {
            return true
        }

        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else {
            return false
        }

        return octets[0] == 100 && (64...127).contains(octets[1])
    }
}

struct NativeOIDCFlow {
    let callbackScheme: String
    let callbackURL: URL
    let state: String
    let codeVerifier: String
    let codeChallenge: String
    private var didConsumeCallback = false

    static func make(callbackScheme: String) throws -> NativeOIDCFlow {
        let state = try randomValue()
        let verifier = try randomValue()
        guard let callbackURL = URL(string: "\(callbackScheme)://oidc-callback") else {
            throw OIDCSignInError.invalidCallback
        }
        return NativeOIDCFlow(
            callbackScheme: callbackScheme.lowercased(),
            callbackURL: callbackURL,
            state: state,
            codeVerifier: verifier,
            codeChallenge: Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
        )
    }

    mutating func exchangeCode(
        from callback: URL,
        expectedFlowID: String,
        expectedServerID: String,
        expiresAt: Date,
        now: Date = Date()
    ) throws -> String {
        guard !didConsumeCallback else { throw OIDCSignInError.replayed }
        guard now < expiresAt else { throw OIDCSignInError.expired }
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == callbackScheme,
              components.host?.lowercased() == "oidc-callback",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.path.isEmpty,
              components.fragment == nil,
              value(named: "state", in: components) == state,
              value(named: "flow_id", in: components) == expectedFlowID,
              value(named: "server_id", in: components) == expectedServerID
        else {
            throw OIDCSignInError.invalidCallback
        }
        let names = Set((components.queryItems ?? []).map(\.name))
        if value(named: "error", in: components) != nil {
            guard names == ["error", "state", "flow_id", "server_id"] else {
                throw OIDCSignInError.invalidCallback
            }
            throw OIDCSignInError.providerFailed
        }
        guard names == ["code", "state", "flow_id", "server_id"] else {
            throw OIDCSignInError.invalidCallback
        }
        guard let code = value(named: "code", in: components) else {
            throw OIDCSignInError.invalidCallback
        }
        didConsumeCallback = true
        return code
    }

    private func value(named name: String, in components: URLComponents) -> String? {
        let values = (components.queryItems ?? []).filter { $0.name == name }
        guard values.count == 1,
              let value = values[0].value,
              !value.isEmpty
        else { return nil }
        return value
    }

    private static func randomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw OIDCSignInError.securityFailure
        }
        return Data(bytes).base64URLEncodedString()
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension Notification.Name {
    public static let talariaReauthenticated = Notification.Name("talariaReauthenticated")
}
