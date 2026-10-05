import XCTest
@testable import TalariaKit

@MainActor
final class LiveActivityTests: XCTestCase {
    override func tearDown() {
        LiveActivityURLProtocol.handler = nil
        super.tearDown()
    }

    func testCompletionInboxRetainsOfflineResultsAndAcknowledgesOnlyObservedIDs() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "completion-inbox-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite); session.invalidateAndCancel() }
        var credentials: TalariaRelayCredentials? = TalariaRelayCredentials(
            baseURL: try XCTUnwrap(URL(string: "https://relay.example")), deviceID: "device", userID: "user",
            appleUserID: "apple-user", sessionToken: "synthetic-token", expiresAt: .distantFuture
        )
        let payload = #"{"completions":[{"id":"completion1","row":{"publisherId":"https://hermes.example","publisherLabel":"Test","sessionId":"session","streamId":"run1","title":"Synthetic task","phase":"completed","status":"Done","updatedAt":1800000000000,"deepLink":"/sessions/session"}}],"cursor":null}"#
        var offline = false
        var acknowledgeSucceeds = false
        var acknowledgements: [[String]] = []
        LiveActivityURLProtocol.handler = { request in
            if offline { throw URLError(.notConnectedToInternet) }
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Device-Id"), "device")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
            let status: Int
            let body: String
            if request.httpMethod == "POST" {
                let object = try JSONSerialization.jsonObject(with: XCTUnwrap(apiTestBodyData(from: request))) as! [String: [String]]
                acknowledgements.append(try XCTUnwrap(object["ids"]))
                status = acknowledgeSucceeds ? 200 : 503
                body = acknowledgeSucceeds ? #"{"ok":true}"# : #"{"error":"temporarily unavailable"}"#
            } else {
                status = 200
                body = payload
            }
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let store = TalariaCompletionStore(defaults: defaults, session: session, credentials: { credentials })
        await store.refresh()
        XCTAssertEqual(store.completions.map(\.id), ["completion1"])
        offline = true
        let relaunched = TalariaCompletionStore(defaults: defaults, session: session, credentials: { credentials })
        await relaunched.refresh()
        XCTAssertEqual(relaunched.completions.map(\.id), ["completion1"])
        XCTAssertNotNil(relaunched.errorMessage)
        offline = false
        let rejected = await relaunched.acknowledge(["not-observed"])
        XCTAssertFalse(rejected)
        XCTAssertTrue(acknowledgements.isEmpty)
        let failed = await relaunched.acknowledge(["completion1"])
        XCTAssertFalse(failed)
        XCTAssertEqual(relaunched.completions.count, 1)
        acknowledgeSucceeds = true
        let accepted = await relaunched.acknowledge(["completion1"])
        XCTAssertTrue(accepted)
        XCTAssertEqual(acknowledgements, [["completion1"], ["completion1"]])
        XCTAssertTrue(relaunched.completions.isEmpty)
        credentials = nil
        await store.refresh()
        XCTAssertTrue(store.completions.isEmpty)
    }

    func testViewedCompletionCleanupPreservesRunningNewerAndOtherThreadCards() {
        let viewedAt = Date(timeIntervalSince1970: 20)
        let running = AgentRunActivityStateReducer.initialState(
            sessionID: "viewed", sessionTitle: "Fixture", startedAt: Date(timeIntervalSince1970: 1)
        )
        var done = AgentRunActivityStateReducer.final(
            status: .complete, activity: "Done", state: running, now: Date(timeIntervalSince1970: 10)
        )
        func matches(_ state: AgentRunActivityAttributes.ContentState, publisher: String = "https://fixture.example") -> Bool {
            AgentLiveActivityReusePolicy.isViewedCompletion(
                state: state, publisherID: publisher, viewedPublisherID: "https://fixture.example",
                viewedSessionID: "viewed", through: viewedAt
            )
        }
        XCTAssertTrue(matches(done))
        XCTAssertFalse(matches(running))
        XCTAssertFalse(matches(done, publisher: "https://other.example"))
        done.updatedAt = Date(timeIntervalSince1970: 21)
        XCTAssertFalse(matches(done))
        done.updatedAt = Date(timeIntervalSince1970: 10)
        done.sessionID = "other"
        XCTAssertFalse(matches(done))
    }

    func testOpeningThreadAcknowledgesOnlyItsExistingCompletions() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "viewed-completion-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite); session.invalidateAndCancel() }
        let credentials = TalariaRelayCredentials(
            baseURL: URL(string: "https://relay.example")!, deviceID: "device", userID: "user",
            appleUserID: "apple", sessionToken: "synthetic-token", expiresAt: .distantFuture
        )
        let first = TalariaRelayClient.Completion(id: "first", row: aggregateRow(sessionID: "viewed", phase: "completed", updatedAt: 100))
        let other = TalariaRelayClient.Completion(id: "other", row: aggregateRow(sessionID: "other", phase: "completed", updatedAt: 100))
        let future = TalariaRelayClient.Completion(id: "future", row: aggregateRow(sessionID: "viewed", phase: "completed", updatedAt: 200))
        var otherPublisherRow = first.row
        otherPublisherRow.publisherId = "https://other.example"
        let otherPublisher = TalariaRelayClient.Completion(id: "other-publisher", row: otherPublisherRow)
        var postedIDs: [String] = []
        var isOffline = false
        var returnsEmptyPage = false
        LiveActivityURLProtocol.handler = { request in
            if isOffline { throw URLError(.notConnectedToInternet) }
            let data: Data
            if request.httpMethod == "POST" {
                let object = try JSONSerialization.jsonObject(with: XCTUnwrap(apiTestBodyData(from: request))) as! [String: [String]]
                postedIDs += object["ids"] ?? []
                data = Data(#"{"ok":true}"#.utf8)
            } else {
                struct Page: Encodable { var completions: [TalariaRelayClient.Completion]; var cursor: String? }
                let isSecondPage = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.contains { $0.name == "cursor" && $0.value == "page-2" } == true
                data = try JSONEncoder().encode(returnsEmptyPage ? Page(completions: [], cursor: nil) : isSecondPage
                    ? Page(completions: [first, future, otherPublisher], cursor: nil)
                    : Page(completions: [other], cursor: "page-2"))
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        let store = TalariaCompletionStore(defaults: defaults, session: session, credentials: { credentials })
        let acknowledged = await store.acknowledgeViewedSession(
            publisherURL: URL(string: "https://hermes.example/path")!, sessionID: "viewed",
            through: Date(timeIntervalSince1970: 0.15)
        )
        XCTAssertEqual(acknowledged?.map(\.id), ["first"])
        XCTAssertEqual(postedIDs, ["first"])
        XCTAssertEqual(Set(store.completions.map(\.id)), ["other", "future", "other-publisher"])

        isOffline = true
        let failed = await store.acknowledgeViewedSession(
            publisherURL: URL(string: "https://hermes.example")!, sessionID: "viewed", through: .distantFuture
        )
        XCTAssertNil(failed)
        isOffline = false
        returnsEmptyPage = true
        let alreadyAcknowledged = await store.acknowledgeViewedSession(
            publisherURL: URL(string: "https://hermes.example")!, sessionID: "viewed", through: .distantFuture
        )
        XCTAssertEqual(alreadyAcknowledged?.count, 0)
    }

    func testCompletionRefreshCannotResurrectAnAcknowledgedResult() async throws {
        let host = "completion-race.example"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "completion-race-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer {
            DeferredMockURLProtocol.setOnRequest(nil, forHost: host)
            defaults.removePersistentDomain(forName: suite)
            session.invalidateAndCancel()
        }
        let credentials = TalariaRelayCredentials(
            baseURL: try XCTUnwrap(URL(string: "https://\(host)")), deviceID: "device", userID: "user",
            appleUserID: "apple-user", sessionToken: "synthetic-token", expiresAt: .distantFuture
        )
        let payload = #"{"completions":[{"id":"completion1","row":{"publisherId":"https://hermes.example","publisherLabel":"Test","sessionId":"session","streamId":"run1","title":"Synthetic task","phase":"completed","status":"Done","updatedAt":1800000000000,"deepLink":"/sessions/session"}}],"cursor":null}"#
        let requests = DeferredRequests()
        let refreshStarted = expectation(description: "stale refresh is in flight")
        DeferredMockURLProtocol.setOnRequest({ request in
            let count = requests.append(request)
            if request.request.httpMethod == "POST" {
                request.complete(withJSON: #"{"ok":true}"#)
            } else if count == 1 {
                request.complete(withJSON: payload)
            } else {
                refreshStarted.fulfill()
            }
        }, forHost: host)
        let store = TalariaCompletionStore(defaults: defaults, session: session, credentials: { credentials })
        await store.refresh()
        let refresh = Task { await store.refresh() }
        await fulfillment(of: [refreshStarted], timeout: 10)
        let acknowledged = await store.acknowledge(["completion1"])
        XCTAssertTrue(acknowledged)
        requests.request(at: 1).complete(withJSON: payload)
        await refresh.value
        XCTAssertTrue(store.completions.isEmpty)
        XCTAssertFalse(store.isLoading)
    }

    func testNativeRelayCompletionDecodesAsFinalWithoutEndingActivity() throws {
        let data = Data(#"{"sessionID":"session","sessionTitle":"Synthetic task","status":"complete","currentActivity":"Done","responseExcerpt":"","startedAt":821692800,"updatedAt":821692800,"isStale":false,"isFinal":true}"#.utf8)
        let state = try JSONDecoder().decode(AgentRunActivityAttributes.ContentState.self, from: data)
        XCTAssertEqual(state.status, .complete)
        XCTAssertTrue(state.isFinal)
        XCTAssertFalse(state.isStale)
        XCTAssertEqual(state.startedAt.timeIntervalSince1970, 1_800_000_000)
    }

    func testTerminalAggregateOutcomeDoesNotShowZeroOrWaiting() {
        let state = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 0, title: "Talaria", subtitle: "Agent work completed", updatedAt: 100,
            rows: [aggregateRow(sessionID: "finished", phase: "completed", updatedAt: 100)]
        )
        XCTAssertTrue(state.hasTerminalRows)
        var mixed = state
        mixed.activeCount = 1
        mixed.rows.append(aggregateRow(sessionID: "running", phase: "thinking", updatedAt: 101))
        XCTAssertTrue(mixed.hasTerminalRows)
        var running = mixed
        running.rows.removeFirst()
        XCTAssertFalse(running.hasTerminalRows)
        var empty = state
        empty.rows = []
        XCTAssertFalse(empty.hasTerminalRows)
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.outcomeTitle(state), "Done")
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.signalPhase(state: state, isStale: true), "completed")
        XCTAssertFalse(TalariaAggregateLiveActivityPresentation.isEffectivelyStale(state: state, isStale: true))
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.signalSymbol(for: "completed"), "checkmark.circle.fill")
        for phase in ["cancelled", "failed"] {
            var outcome = state
            outcome.rows[0].phase = phase
            XCTAssertEqual(TalariaAggregateLiveActivityPresentation.signalPhase(state: outcome, isStale: true), phase)
        }
    }

    func testRelayCredentialsRoundTripThroughKeychain() throws {
        let keychain = InMemoryKeychainStore()
        let credentials = TalariaRelayCredentials(
            baseURL: try XCTUnwrap(URL(string: "https://relay.example.com")),
            deviceID: "device-1",
            userID: "user-1",
            appleUserID: "apple-user-1",
            sessionToken: "secret",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
        )

        try TalariaRelayConfigurationStore.save(credentials, keychain: keychain)
        XCTAssertEqual(TalariaRelayConfigurationStore.load(keychain: keychain), credentials)
        try TalariaRelayConfigurationStore.recordPairedPublisher(
            try XCTUnwrap(URL(string: "https://one.example")),
            keychain: keychain
        )
        try TalariaRelayConfigurationStore.recordPairedPublisher(
            try XCTUnwrap(URL(string: "https://two.example")),
            keychain: keychain
        )
        try TalariaRelayConfigurationStore.removePairedPublisher(
            try XCTUnwrap(URL(string: "https://one.example")),
            keychain: keychain
        )
        XCTAssertEqual(
            TalariaRelayConfigurationStore.load(keychain: keychain)?.pairedPublisherIDs,
            ["https://two.example"]
        )
        try TalariaRelayConfigurationStore.replacePairedPublishers(
            ["https://THREE.example:443/path", "invalid"],
            keychain: keychain
        )
        XCTAssertEqual(
            TalariaRelayConfigurationStore.load(keychain: keychain)?.pairedPublisherIDs,
            ["https://three.example"]
        )
        var expired = credentials
        expired.expiresAt = .distantPast
        XCTAssertTrue(expired.isExpired)
        try TalariaRelayConfigurationStore.clear(keychain: keychain)
        XCTAssertNil(TalariaRelayConfigurationStore.load(keychain: keychain))
    }

    func testRelayOwnsCompletionAlertsOnlyForPairedOperationalServer() throws {
        let keychain = InMemoryKeychainStore()
        let suite = "relay-alert-owner-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("push-token", forKey: TalariaRelayNotifications.pushTokenKey)
        let previousMode = UserDefaults.standard.string(forKey: TalariaLiveActivityMode.storageKey)
        UserDefaults.standard.set(TalariaLiveActivityMode.perSession.rawValue, forKey: TalariaLiveActivityMode.storageKey)
        defer {
            if let previousMode {
                UserDefaults.standard.set(previousMode, forKey: TalariaLiveActivityMode.storageKey)
            } else {
                UserDefaults.standard.removeObject(forKey: TalariaLiveActivityMode.storageKey)
            }
        }
        var credentials = TalariaRelayCredentials(
            baseURL: try XCTUnwrap(URL(string: "https://relay.example.com")),
            deviceID: "device-1",
            userID: "user-1",
            appleUserID: "apple-user-1",
            sessionToken: "secret",
            expiresAt: .distantFuture
        )
        try TalariaRelayConfigurationStore.save(credentials, keychain: keychain)
        let pairedServer = try XCTUnwrap(URL(string: "https://Hermes.Example:443/path"))
        try TalariaRelayConfigurationStore.recordPairedPublisher(pairedServer, keychain: keychain)

        XCTAssertTrue(TalariaRelayConfigurationStore.ownsCompletionAlerts(
            for: pairedServer,
            keychain: keychain,
            defaults: defaults
        ))
        defaults.removeObject(forKey: TalariaRelayNotifications.pushTokenKey)
        XCTAssertFalse(TalariaRelayConfigurationStore.ownsCompletionAlerts(
            for: pairedServer,
            keychain: keychain,
            defaults: defaults
        ))
        XCTAssertNotNil(TalariaRelayConfigurationStore.operationalCredentials(
            for: pairedServer,
            keychain: keychain
        ))
        defaults.set("push-token", forKey: TalariaRelayNotifications.pushTokenKey)
        XCTAssertFalse(TalariaRelayConfigurationStore.ownsCompletionAlerts(
            for: try XCTUnwrap(URL(string: "https://other.example")),
            keychain: keychain,
            defaults: defaults
        ))

        credentials = try XCTUnwrap(TalariaRelayConfigurationStore.load(keychain: keychain))
        credentials.pendingRevocation = true
        try TalariaRelayConfigurationStore.save(credentials, keychain: keychain)
        XCTAssertFalse(TalariaRelayConfigurationStore.ownsCompletionAlerts(
            for: pairedServer,
            keychain: keychain,
            defaults: defaults
        ))
    }

    func testRelayConnectionStateDistinguishesEveryStoredState() throws {
        let server = try XCTUnwrap(URL(string: "https://hermes.example.com/path"))
        let publisherID = try XCTUnwrap(TalariaRelayClient.originURL(server)?.absoluteString)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var credentials = TalariaRelayCredentials(
            baseURL: try XCTUnwrap(URL(string: "https://relay.example.com")),
            deviceID: "device-1",
            userID: "user-1",
            appleUserID: "apple-user-1",
            sessionToken: "secret",
            expiresAt: now.addingTimeInterval(60)
        )

        XCTAssertEqual(TalariaRelayConfigurationStore.connectionState(
            for: server,
            credentials: nil,
            now: now
        ), .signedOut)
        XCTAssertEqual(TalariaRelayConfigurationStore.connectionState(
            for: server,
            credentials: credentials,
            now: now
        ), .unpaired)

        credentials.pairedPublisherIDs = [publisherID]
        XCTAssertEqual(TalariaRelayConfigurationStore.connectionState(
            for: server,
            credentials: credentials,
            now: now
        ), .connected)

        credentials.expiresAt = now
        XCTAssertEqual(TalariaRelayConfigurationStore.connectionState(
            for: server,
            credentials: credentials,
            now: now
        ), .expired)

        credentials.pendingRevocation = true
        XCTAssertEqual(TalariaRelayConfigurationStore.connectionState(
            for: server,
            credentials: credentials,
            now: now
        ), .disconnectPending)
    }

    func testRelayPublisherOriginCanonicalizesDefaultPorts() throws {
        XCTAssertEqual(
            TalariaRelayClient.originURL(try XCTUnwrap(URL(string: "https://Example.COM:443/path")))?.absoluteString,
            "https://example.com"
        )
        XCTAssertEqual(
            TalariaRelayClient.originURL(try XCTUnwrap(URL(string: "http://Example.COM:80/path")))?.absoluteString,
            "http://example.com"
        )
        XCTAssertEqual(
            TalariaRelayClient.originIdentifier("https://Example.COM:443/path"),
            "https://example.com"
        )
    }

    func testRelayAppleCredentialLookupPreservesIndeterminateErrors() {
        XCTAssertEqual(
            TalariaRelayAppleCredentialState.resolvedStatus(state: .authorized, error: nil),
            .authorized
        )
        XCTAssertEqual(
            TalariaRelayAppleCredentialState.resolvedStatus(state: .revoked, error: nil),
            .revoked
        )
        XCTAssertEqual(
            TalariaRelayAppleCredentialState.resolvedStatus(state: .notFound, error: nil),
            .revoked
        )
        XCTAssertEqual(
            TalariaRelayAppleCredentialState.resolvedStatus(
                state: .authorized,
                error: URLError(.notConnectedToInternet)
            ),
            .unknown
        )
        XCTAssertEqual(
            TalariaRelayAppleCredentialState.resolvedStatus(state: .transferred, error: nil),
            .unknown
        )
    }

    func testRelayAppleSignInPairingAndAggregateSnapshotContract() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let session = URLSession(configuration: configuration)
        var requests: [URLRequest] = []
        LiveActivityURLProtocol.handler = { request in
            requests.append(request)
            let body: String
            switch request.url?.path {
            case "/v1/auth/apple":
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
                body = #"{"userId":"user-1","sessionToken":"secret","expiresAt":1900000000000}"#
            case "/v1/pairings/publisher":
                body = #"{"invitation":"invite-once","expiresAt":1787845600000}"#
            case _ where request.url?.path.hasSuffix("/publisher-subscriptions") == true:
                body = request.httpMethod == "GET"
                    ? #"{"publishers":[{"publisherId":"https://hermes.example.com","label":"Home","subscribed":true}]}"#
                    : #"{"ok":true}"#
            case "/v1/publisher-enrollment":
                body = #"{"ok":true}"#
            case "/api/talaria/relay/pair":
                body = #"{"ok":true,"publisher_id":"https://hermes.example.com"}"#
            case "/v1/activity-snapshot":
                body = #"{"aggregate":{"schemaVersion":1,"activeCount":2,"title":"Talaria","subtitle":"2 active sessions","updatedAt":1787845600000,"rows":[{"publisherId":"pub-1","publisherLabel":"Home","sessionId":"session-1","title":"Build app","phase":"running","status":"Working","updatedAt":1787845600000,"deepLink":"/sessions/session-1"}]}}"#
            default:
                body = #"{"ok":true}"#
            }
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(body.utf8))
        }

        let credentials = try await TalariaRelayClient.signIn(
            identityToken: Data("apple-jwt".utf8),
            nonce: "hashed-nonce",
            appleUserID: "apple-user-1",
            baseURL: try XCTUnwrap(URL(string: "https://relay.example.com")),
            session: session
        )
        let client = TalariaRelayClient(credentials: credentials, session: session)
        let invitation = try await client.createPublisherInvitation()
        XCTAssertEqual(invitation, "invite-once")
        try await APIClient(
            baseURL: try XCTUnwrap(URL(string: "https://hermes.example.com")),
            session: session,
            publicMediaSession: session,
            customHeaderProvider: { [CustomHeader(name: "X-Relay-Test", value: "server-a")] }
        ).pairTalariaRelay(
            invitation: "invite-once",
            relayURL: credentials.baseURL,
            publisherID: try XCTUnwrap(URL(string: "https://hermes.example.com"))
        )
        let appleRequest = try XCTUnwrap(requests.first { $0.url?.path == "/v1/auth/apple" })
        let appleBody = try XCTUnwrap(JSONSerialization.jsonObject(
            with: try XCTUnwrap(apiTestBodyData(from: appleRequest))
        ) as? [String: String])
        XCTAssertEqual(appleBody["identityToken"], "apple-jwt")
        XCTAssertEqual(appleBody["nonce"], "hashed-nonce")
        let pairingRequest = try XCTUnwrap(requests.first { $0.url?.path == "/api/talaria/relay/pair" })
        let pairingBody = try XCTUnwrap(JSONSerialization.jsonObject(
            with: try XCTUnwrap(apiTestBodyData(from: pairingRequest))
        ) as? [String: String])
        XCTAssertEqual(pairingBody["relay_url"], "https://relay.example.com")
        XCTAssertEqual(pairingBody["publisher_id"], "https://hermes.example.com")
        XCTAssertEqual(pairingBody["publisher_invitation"], "invite-once")
        XCTAssertEqual(pairingRequest.value(forHTTPHeaderField: "X-Relay-Test"), "server-a")
        UserDefaults.standard.set(true, forKey: TalariaRelayNotifications.isEnabledKey)
        UserDefaults.standard.set(false, forKey: ResponseCompletionNotifications.isEnabledKey)
        UserDefaults.standard.set("ordinary-push-token", forKey: TalariaRelayNotifications.pushTokenKey)
        UserDefaults.standard.set("push-to-start-token", forKey: TalariaRelayNotifications.pushToStartTokenKey)
        defer {
            UserDefaults.standard.removeObject(forKey: TalariaRelayNotifications.isEnabledKey)
            UserDefaults.standard.removeObject(forKey: ResponseCompletionNotifications.isEnabledKey)
            UserDefaults.standard.removeObject(forKey: TalariaRelayNotifications.pushTokenKey)
            UserDefaults.standard.removeObject(forKey: TalariaRelayNotifications.pushToStartTokenKey)
        }
        try await client.configureDevice()
        let registrationBody = try XCTUnwrap(requests.last.flatMap(apiTestBodyData))
        let registration = try XCTUnwrap(JSONSerialization.jsonObject(with: registrationBody) as? [String: Any])
        let preferences = try XCTUnwrap(registration["preferences"] as? [String: Bool])
        XCTAssertEqual(registration["pushToken"] as? String, "ordinary-push-token")
        XCTAssertEqual(registration["pushToStartToken"] as? String, "push-to-start-token")
        XCTAssertEqual(preferences["notificationsEnabled"], true)
        XCTAssertEqual(preferences["notifyOnApproval"], true)
        XCTAssertEqual(preferences["notifyOnInput"], true)
        XCTAssertEqual(preferences["notifyOnCompletion"], false)
        XCTAssertEqual(preferences["notifyOnFailure"], false)

        UserDefaults.standard.set(false, forKey: TalariaRelayNotifications.isEnabledKey)
        UserDefaults.standard.set(true, forKey: ResponseCompletionNotifications.isEnabledKey)
        try await client.configureDevice()
        let completionBody = try XCTUnwrap(requests.last.flatMap(apiTestBodyData))
        let completionRegistration = try XCTUnwrap(
            JSONSerialization.jsonObject(with: completionBody) as? [String: Any]
        )
        let completionPreferences = try XCTUnwrap(completionRegistration["preferences"] as? [String: Bool])
        XCTAssertEqual(completionPreferences["notificationsEnabled"], true)
        XCTAssertEqual(completionPreferences["notifyOnApproval"], false)
        XCTAssertEqual(completionPreferences["notifyOnInput"], false)
        XCTAssertEqual(completionPreferences["notifyOnCompletion"], true)
        XCTAssertEqual(completionPreferences["notifyOnFailure"], true)

        try await client.configureDevice(pushToStartEnabled: false)
        let perSessionDeviceBody = try XCTUnwrap(requests.last.flatMap(apiTestBodyData))
        let perSessionDevice = try XCTUnwrap(
            JSONSerialization.jsonObject(with: perSessionDeviceBody) as? [String: Any]
        )
        let perSessionPreferences = try XCTUnwrap(perSessionDevice["preferences"] as? [String: Bool])
        XCTAssertEqual(perSessionPreferences["liveActivitiesEnabled"], true)
        XCTAssertTrue(perSessionDevice["pushToStartToken"] is NSNull)

        try await client.configureDevice(liveActivitiesEnabled: false)
        let disabledBody = try XCTUnwrap(requests.last.flatMap(apiTestBodyData))
        let disabledRegistration = try XCTUnwrap(JSONSerialization.jsonObject(with: disabledBody) as? [String: Any])
        let disabledPreferences = try XCTUnwrap(disabledRegistration["preferences"] as? [String: Bool])
        XCTAssertEqual(disabledPreferences["liveActivitiesEnabled"], false)
        XCTAssertEqual(disabledPreferences["notificationsEnabled"], false)
        XCTAssertTrue(disabledRegistration["pushToStartToken"] is NSNull)

        let aggregate = try await client.snapshot()

        XCTAssertEqual(credentials.baseURL.absoluteString, "https://relay.example.com")
        XCTAssertEqual(credentials.userID, "user-1")
        XCTAssertEqual(credentials.appleUserID, "apple-user-1")
        XCTAssertEqual(credentials.expiresAt, Date(timeIntervalSince1970: 1_900_000_000))
        XCTAssertFalse(credentials.isExpired)
        XCTAssertEqual(aggregate?.activeCount, 2)
        XCTAssertEqual(aggregate?.rows.first?.sessionId, "session-1")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "X-Talaria-Device-Id"), credentials.deviceID)
        XCTAssertEqual(URLComponents(url: requests.last!.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "all_running")

        try await client.register(
            activityID: "activity-1",
            pushToken: "activity-token",
            seededLocally: true
        )
        let seededRegistrationBody = try XCTUnwrap(requests.last.flatMap(apiTestBodyData))
        let seededRegistration = try XCTUnwrap(
            JSONSerialization.jsonObject(with: seededRegistrationBody) as? [String: Any]
        )
        XCTAssertEqual(seededRegistration["mode"] as? String, "all_running")
        XCTAssertEqual(seededRegistration["activityPushToken"] as? String, "activity-token")
        XCTAssertEqual(seededRegistration["seededLocally"] as? Bool, true)

        try await client.registerPerSession(
            activityID: "activity-session-1",
            pushToken: "session-token",
            publisherID: "https://hermes.example.com",
            sessionID: "session-1",
            streamID: "stream-1"
        )
        let perSessionBody = try XCTUnwrap(requests.last.flatMap(apiTestBodyData))
        let perSessionRegistration = try XCTUnwrap(
            JSONSerialization.jsonObject(with: perSessionBody) as? [String: Any]
        )
        XCTAssertEqual(perSessionRegistration["streamId"] as? String, "stream-1")
        XCTAssertEqual(perSessionRegistration["mode"] as? String, "per_session")
        XCTAssertEqual(perSessionRegistration["publisherId"] as? String, "https://hermes.example.com")
        XCTAssertEqual(perSessionRegistration["sessionId"] as? String, "session-1")
        XCTAssertEqual(perSessionRegistration["attributesType"] as? String, "AgentRunActivityAttributes")
        XCTAssertEqual(perSessionRegistration["seededLocally"] as? Bool, false)

        let publisherID = try XCTUnwrap(URL(string: "https://hermes.example.com"))
        try await client.setPublisherSubscription(publisherID, subscribed: false)
        let subscriptionRequest = try XCTUnwrap(requests.last)
        let subscriptionBody = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try XCTUnwrap(apiTestBodyData(from: subscriptionRequest)))
                as? [String: Any]
        )
        XCTAssertEqual(subscriptionRequest.httpMethod, "PUT")
        XCTAssertEqual(subscriptionBody["publisherId"] as? String, "https://hermes.example.com")
        XCTAssertEqual(subscriptionBody["subscribed"] as? Bool, false)
        let subscriptions = try await client.publisherSubscriptions()
        XCTAssertEqual(subscriptions, [
            TalariaRelayClient.PublisherSubscription(
                publisherId: "https://hermes.example.com",
                label: "Home",
                subscribed: true
            )
        ])
        try await client.revokePublisher(publisherID)
        let revokeRequest = try XCTUnwrap(requests.last)
        XCTAssertEqual(revokeRequest.httpMethod, "DELETE")
        XCTAssertEqual(revokeRequest.url?.path, "/v1/publisher-enrollment")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(revokeRequest.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first,
            URLQueryItem(name: "publisherId", value: "https://hermes.example.com")
        )

        try await client.unregister(activityID: "activity-1")
        try await client.revokeDevice()
        XCTAssertEqual(
            requests.suffix(2).map { ($0.httpMethod ?? "") + " " + ($0.url?.path ?? "") },
            [
                "DELETE /v1/devices/\(credentials.deviceID)/live-activities/activity-1",
                "DELETE /v1/devices/\(credentials.deviceID)"
            ]
        )
    }

    func testRelayRedirectGuardCancelsEveryCrossOriginRedirect() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://relay.example.com"))
        let guardDelegate = TalariaRelayRedirectGuard(baseURL: baseURL)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: baseURL)
        for (statusCode, destination) in [
            (301, "http://relay.example.com/capture"),
            (302, "https://attacker.example/capture"),
            (303, "https://relay.example.com:8443/capture"),
            (307, "https://attacker.example/capture"),
            (308, "https://attacker.example/capture")
        ] {
            var redirected = URLRequest(url: try XCTUnwrap(URL(string: destination)))
            redirected.httpMethod = "POST"
            redirected.httpBody = try JSONEncoder().encode([
                "identityToken": "synthetic-apple-token",
                "nonce": "synthetic-nonce"
            ])
            redirected.setValue("Bearer synthetic-session-token", forHTTPHeaderField: "Authorization")
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: baseURL,
                    statusCode: statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil
                )
            )
            var completionCalled = false
            var outcome: URLRequest?

            guardDelegate.urlSession(
                session,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: redirected
            ) {
                completionCalled = true
                outcome = $0
            }

            XCTAssertTrue(completionCalled)
            XCTAssertNil(outcome, "HTTP \(statusCode) authorized a cross-origin next hop")
        }
    }

    func testRelayRedirectGuardKeepsSameOriginRequestAndBearerCredentials() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://relay.example.com"))
        let guardDelegate = TalariaRelayRedirectGuard(baseURL: baseURL)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: baseURL)
        var redirected = URLRequest(url: try XCTUnwrap(URL(string: "https://RELAY.example.com:443/next")))
        redirected.httpMethod = "POST"
        redirected.httpBody = Data("synthetic-body".utf8)
        redirected.setValue("Bearer synthetic-session-token", forHTTPHeaderField: "Authorization")
        let response = try XCTUnwrap(
            HTTPURLResponse(url: baseURL, statusCode: 307, httpVersion: "HTTP/1.1", headerFields: nil)
        )
        var outcome: URLRequest?

        guardDelegate.urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: redirected
        ) { outcome = $0 }

        XCTAssertEqual(outcome?.httpBody, Data("synthetic-body".utf8))
        XCTAssertEqual(
            outcome?.value(forHTTPHeaderField: "Authorization"),
            "Bearer synthetic-session-token"
        )
    }

    func testRelayClientOwnsGuardedDefaultSessionAndPreservesInjection() throws {
        let credentials = TalariaRelayCredentials(
            baseURL: try XCTUnwrap(URL(string: "https://relay.example.com")),
            deviceID: "synthetic-device",
            userID: "synthetic-user",
            appleUserID: "synthetic-apple-user",
            sessionToken: "synthetic-session-token",
            expiresAt: .distantFuture
        )
        let injected = URLSession(configuration: .ephemeral)
        defer { injected.invalidateAndCancel() }

        let owned = TalariaRelayClient(credentials: credentials)
        XCTAssertTrue(owned.session.delegate is TalariaRelayRedirectGuard)
        XCTAssertTrue(TalariaRelayClient(credentials: credentials, session: injected).session === injected)
    }

    func testSanitizesLiveActivityText() {
        let title = AgentRunActivitySanitizer.sessionTitle("  A very long Hermes session title with\nmultiple lines and extra words  ")
        let activity = AgentRunActivitySanitizer.activityLine("Reading /Users/example/project/Secrets.swift\nwith details")
        let excerpt = AgentRunActivitySanitizer.responseExcerpt(String(repeating: "A", count: 180))

        XCTAssertFalse(title.contains("\n"))
        XCTAssertLessThanOrEqual(title.count, AgentRunActivitySanitizer.maximumSessionTitleCharacters)
        XCTAssertFalse(activity.contains("\n"))
        XCTAssertLessThanOrEqual(activity.count, AgentRunActivitySanitizer.maximumActivityCharacters)
        XCTAssertLessThanOrEqual(excerpt.count, AgentRunActivitySanitizer.maximumExcerptCharacters)
    }

    func testBuildsImmediateAggregateSeedForLocalWork() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let state = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: " session-abc ",
            sessionTitle: " Local work ",
            publisherURL: try XCTUnwrap(URL(string: "https://Hermes.Example:443/path")),
            now: now
        ))

        XCTAssertEqual(state.activeCount, 1)
        XCTAssertEqual(state.subtitle, "1 active session")
        XCTAssertEqual(state.updatedAt, 1_800_000_000_000)
        XCTAssertEqual(state.rows.count, 1)
        XCTAssertEqual(state.rows[0].publisherId, "https://hermes.example")
        XCTAssertEqual(state.rows[0].publisherLabel, "hermes.example")
        XCTAssertEqual(state.rows[0].sessionId, "session-abc")
        XCTAssertEqual(state.rows[0].title, "Local work")
        XCTAssertEqual(state.rows[0].phase, "starting")
        XCTAssertEqual(state.rows[0].status, "Connecting")
    }

    func testMergesImmediateSeedIntoExistingAggregate() throws {
        let existing = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 2,
            title: "Talaria",
            subtitle: "1 needs attention",
            updatedAt: 100,
            rows: [
                aggregateRow(sessionID: "approval", phase: "waiting_for_approval", updatedAt: 90),
                aggregateRow(sessionID: "running", phase: "running", updatedAt: 80),
                aggregateRow(sessionID: "done", phase: "completed", updatedAt: 70),
                aggregateRow(sessionID: "cancelled", phase: "cancelled", updatedAt: 60),
                aggregateRow(sessionID: "stale", phase: "stale", updatedAt: 50)
            ]
        )
        let seed = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: "new-session",
            sessionTitle: "New work",
            publisherURL: try XCTUnwrap(URL(string: "https://hermes.example")),
            now: Date(timeIntervalSince1970: 1)
        ))

        let merged = TalariaAggregateActivitySeed.merging(seed, into: existing)

        XCTAssertEqual(merged.activeCount, 3)
        XCTAssertEqual(merged.subtitle, "1 needs attention")
        XCTAssertEqual(
            merged.rows.map(\.sessionId),
            ["approval", "new-session", "running", "done", "cancelled"]
        )
    }

    func testMergingImmediateSeedReplacesActiveSessionWithoutDoubleCounting() throws {
        let existing = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 1,
            title: "Talaria",
            subtitle: "1 active session",
            updatedAt: 100,
            rows: [aggregateRow(sessionID: "same", phase: "running", updatedAt: 100)]
        )
        let seed = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: "same",
            sessionTitle: "Restarted work",
            publisherURL: try XCTUnwrap(URL(string: "https://hermes.example")),
            now: Date(timeIntervalSince1970: 1)
        ))

        let merged = TalariaAggregateActivitySeed.merging(seed, into: existing)

        XCTAssertEqual(merged.activeCount, 1)
        XCTAssertEqual(merged.rows.count, 1)
        XCTAssertEqual(merged.rows[0].phase, "starting")
        XCTAssertEqual(merged.rows[0].status, "Connecting")
    }

    func testMergingSeedPreservesAuthoritativeCountWhenActiveRowsAreOmitted() throws {
        let existing = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 2,
            title: "Talaria",
            subtitle: "2 active sessions",
            updatedAt: 2_000,
            rows: [aggregateRow(sessionID: "visible", phase: "running", updatedAt: 2_000)]
        )
        let seed = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: "hidden-or-new",
            sessionTitle: "Local work",
            publisherURL: try XCTUnwrap(URL(string: "https://hermes.example")),
            now: Date(timeIntervalSince1970: 1)
        ))

        let merged = TalariaAggregateActivitySeed.merging(seed, into: existing)

        XCTAssertEqual(merged.activeCount, 2)
        XCTAssertEqual(Set(merged.rows.map(\.sessionId)), Set(["visible", "hidden-or-new"]))

        var olderSnapshot = existing
        olderSnapshot.updatedAt = 100
        XCTAssertEqual(
            TalariaAggregateActivitySeed.merging(seed, into: olderSnapshot).activeCount,
            3
        )
    }

    func testMergingQueuedSeedsRetainsEveryConcurrentSession() throws {
        let existing = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 1,
            title: "Talaria",
            subtitle: "1 active session",
            updatedAt: 100,
            rows: [aggregateRow(sessionID: "existing", phase: "running", updatedAt: 100)]
        )
        let first = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: "first",
            sessionTitle: "First local run",
            publisherURL: try XCTUnwrap(URL(string: "https://hermes.example")),
            now: Date(timeIntervalSince1970: 1)
        ))
        let second = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: "second",
            sessionTitle: "Second local run",
            publisherURL: try XCTUnwrap(URL(string: "https://hermes.example")),
            now: Date(timeIntervalSince1970: 2)
        ))

        let merged = TalariaAggregateActivitySeed.merging([first, second], into: existing)

        XCTAssertEqual(merged.activeCount, 3)
        XCTAssertEqual(Set(merged.rows.map(\.sessionId)), Set(["existing", "first", "second"]))
    }

    func testNewerTerminalAggregateRowRetiresPendingSeed() throws {
        let seed = try XCTUnwrap(TalariaAggregateActivitySeed.make(
            sessionID: "session",
            sessionTitle: "Local run",
            publisherURL: try XCTUnwrap(URL(string: "https://hermes.example")),
            now: Date(timeIntervalSince1970: 1)
        ))

        XCTAssertTrue(TalariaAggregateActivitySeed.authoritativeRowRetiresSeed(
            aggregateRow(sessionID: "session", phase: "completed", updatedAt: 1_001),
            seed: seed
        ))
        XCTAssertFalse(TalariaAggregateActivitySeed.authoritativeRowRetiresSeed(
            aggregateRow(sessionID: "session", phase: "completed", updatedAt: 999),
            seed: seed
        ))
        XCTAssertFalse(TalariaAggregateActivitySeed.authoritativeRowRetiresSeed(
            aggregateRow(sessionID: "session", phase: "running", updatedAt: 999),
            seed: seed
        ))
        XCTAssertTrue(TalariaAggregateActivitySeed.authoritativeRowRetiresSeed(
            aggregateRow(sessionID: "session", phase: "running", updatedAt: 1_001),
            seed: seed
        ))
        var localPlaceholder = aggregateRow(
            sessionID: "session",
            phase: "starting",
            updatedAt: seed.updatedAt
        )
        localPlaceholder.status = "Connecting"
        XCTAssertFalse(TalariaAggregateActivitySeed.authoritativeRowRetiresSeed(
            localPlaceholder,
            seed: seed
        ))
    }

    func testAggregatePresentationPolicyHandlesStaleAndAttentionStates() {
        let state = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 2,
            title: "Talaria",
            subtitle: "2 active sessions",
            updatedAt: 100,
            rows: [aggregateRow(sessionID: "approval", phase: "waiting_for_approval", updatedAt: 100)]
        )

        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.lockScreenRowLimit, 5)
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.expandedIslandRowLimit, 3)
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.signalPhase(state: state, isStale: false),
            "waiting_for_approval"
        )
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.signalPhase(state: state, isStale: true),
            "stale"
        )
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.headerText(state: state, isStale: true),
            "Waiting for server"
        )
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.statusText("Working", isStale: true),
            "Waiting"
        )
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.colorHex(for: "completed"), 0x059669)
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.colorHex(for: "running"), 0x0284C7)
    }

    func testAggregatePresentationKeepsWorkingTintWhenLuminanceIsReduced() {
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.colorHex(
                for: "running",
                isLuminanceReduced: true
            ),
            0x0284C7
        )
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.colorHex(
                for: "starting",
                isLuminanceReduced: true
            ),
            0x0284C7
        )
        XCTAssertNil(TalariaAggregateLiveActivityPresentation.colorHex(
            for: "waiting_for_approval",
            isLuminanceReduced: true
        ))
    }

    func testTerminalAggregateOverridesStalePresentation() {
        let state = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 0,
            title: "Talaria",
            subtitle: "Agent work completed",
            updatedAt: 100,
            rows: [aggregateRow(sessionID: "done", phase: "completed", updatedAt: 100)]
        )

        XCTAssertFalse(TalariaAggregateLiveActivityPresentation.isEffectivelyStale(
            state: state,
            isStale: true
        ))
        XCTAssertEqual(
            TalariaAggregateLiveActivityPresentation.headerText(state: state, isStale: true),
            "Agent work completed"
        )
        XCTAssertEqual(TalariaAggregateLiveActivityPresentation.signalPhase(state: state, isStale: true), "completed")
    }

    private func aggregateRow(
        sessionID: String,
        phase: String,
        updatedAt: Double
    ) -> TalariaAggregateActivityAttributes.ContentState.Row {
        .init(
            publisherId: "https://hermes.example",
            publisherLabel: "Hermes",
            sessionId: sessionID,
            title: sessionID,
            phase: phase,
            status: phase,
            updatedAt: updatedAt,
            deepLink: "/sessions/\(sessionID)"
        )
    }

    func testMapsServerToolKindsToSafeStatuses() {
        let startedAt = Date(timeIntervalSince1970: 100)
        let state = AgentRunActivityStateReducer.initialState(
            sessionID: "session-abc",
            sessionTitle: "Build fixes",
            startedAt: startedAt
        )

        let command = AgentRunActivityStateReducer.toolStarted(kind: .shell, name: "shell_command", state: state)
        XCTAssertEqual(command.status, .runningCommand)
        XCTAssertEqual(command.currentActivity, "Running command")

        let search = AgentRunActivityStateReducer.toolStarted(kind: .search, name: "ripgrep_search", state: state)
        XCTAssertEqual(search.status, .searchingFiles)
        XCTAssertEqual(search.currentActivity, "Searching files")

        let files = AgentRunActivityStateReducer.toolStarted(kind: .list, name: "list_directory", state: state)
        XCTAssertEqual(files.status, .readingFiles)

        let generic = AgentRunActivityStateReducer.toolStarted(kind: .write, name: "apply_patch", state: state)
        XCTAssertEqual(generic.status, .usingTool)
        XCTAssertEqual(generic.currentActivity, "Using apply patch")

        // The server's kind decides: `merge` is not a search, and an older server's missing kind is a generic tool.
        let merge = AgentRunActivityStateReducer.toolStarted(kind: .unknown, name: "merge_pull_request", state: state)
        XCTAssertEqual(merge.status, .usingTool)
        let legacy = AgentRunActivityStateReducer.toolStarted(kind: nil, name: "shell_command", state: state)
        XCTAssertEqual(legacy.status, .usingTool)
    }

    func testElapsedTimeFormatterUsesStableClockLabels() {
        let startedAt = Date(timeIntervalSince1970: 100)

        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(
                startedAt: startedAt,
                updatedAt: Date(timeIntervalSince1970: 100)
            ),
            "00:00"
        )
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(
                startedAt: startedAt,
                updatedAt: Date(timeIntervalSince1970: 106)
            ),
            "00:06"
        )
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(
                startedAt: startedAt,
                updatedAt: Date(timeIntervalSince1970: 190)
            ),
            "01:30"
        )
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(
                startedAt: startedAt,
                updatedAt: Date(timeIntervalSince1970: 3_761)
            ),
            "1:01:01"
        )
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(
                startedAt: startedAt,
                updatedAt: Date(timeIntervalSince1970: 99)
            ),
            "00:00"
        )
    }

    func testNewRunCleanupPreservesOnlyRelayBackedCompletedActivities() {
        XCTAssertTrue(AgentLiveActivityReusePolicy.preservesCompletedActivity(isFinal: true, relayPublisherID: "https://relay.example"))
        XCTAssertFalse(AgentLiveActivityReusePolicy.preservesCompletedActivity(isFinal: false, relayPublisherID: "https://relay.example"))
        XCTAssertFalse(AgentLiveActivityReusePolicy.preservesCompletedActivity(isFinal: true, relayPublisherID: nil))
    }

    func testLiveActivityReusePolicyRequiresMatchingSessionAndStream() {
        XCTAssertTrue(
            AgentLiveActivityReusePolicy.canReuseActivity(
                existingSessionID: "session-abc",
                existingStreamID: "stream-1",
                requestedSessionID: "session-abc",
                requestedStreamID: "stream-1"
            )
        )
        XCTAssertTrue(
            AgentLiveActivityReusePolicy.canReuseActivity(
                existingSessionID: "session-abc",
                existingStreamID: " stream-1 ",
                requestedSessionID: "session-abc",
                requestedStreamID: "stream-1"
            )
        )
        XCTAssertFalse(
            AgentLiveActivityReusePolicy.canReuseActivity(
                existingSessionID: "session-abc",
                existingStreamID: "stream-1",
                requestedSessionID: "session-abc",
                requestedStreamID: "stream-2"
            )
        )
        XCTAssertFalse(
            AgentLiveActivityReusePolicy.canReuseActivity(
                existingSessionID: "session-abc",
                existingStreamID: "stream-1",
                requestedSessionID: "session-abc",
                requestedStreamID: "stream-2"
            )
        )
        XCTAssertFalse(
            AgentLiveActivityReusePolicy.canReuseActivity(
                existingSessionID: "session-abc",
                existingStreamID: nil,
                requestedSessionID: "session-abc",
                requestedStreamID: "stream-2"
            )
        )
        XCTAssertFalse(
            AgentLiveActivityReusePolicy.canReuseActivity(
                existingSessionID: "other-session",
                existingStreamID: "stream-1",
                requestedSessionID: "session-abc",
                requestedStreamID: "stream-2"
            )
        )
    }

    func testLiveActivityAttributesPersistRelayPublisherIdentityTolerantly() throws {
        struct LegacyAttributes: Encodable {
            var sessionID: String
            var sessionTitle: String
            var streamID: String?
            var startedAt: Date
        }

        let startedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let attributes = AgentRunActivityAttributes(
            sessionID: "session-abc",
            sessionTitle: "Relay work",
            streamID: "stream-1",
            startedAt: startedAt,
            relayPublisherID: "https://hermes.example"
        )
        let roundTrip = try JSONDecoder().decode(
            AgentRunActivityAttributes.self,
            from: JSONEncoder().encode(attributes)
        )
        XCTAssertEqual(roundTrip.relayPublisherID, "https://hermes.example")

        let legacy = try JSONDecoder().decode(
            AgentRunActivityAttributes.self,
            from: JSONEncoder().encode(LegacyAttributes(
                sessionID: "session-abc",
                sessionTitle: "Relay work",
                streamID: "stream-1",
                startedAt: startedAt
            ))
        )
        XCTAssertNil(legacy.relayPublisherID)
    }

    func testActiveLiveActivityStatesCarryRenderableText() {
        let startedAt = Date(timeIntervalSince1970: 100)
        let later = Date(timeIntervalSince1970: 106)
        let initial = AgentRunActivityStateReducer.initialState(
            sessionID: "session-abc",
            sessionTitle: "Active render",
            startedAt: startedAt
        )
        let states = [
            initial,
            AgentRunActivityStateReducer.reasoning("Thinking through the plan", state: initial, now: later),
            AgentRunActivityStateReducer.toolStarted(kind: .search, name: "ripgrep_search", state: initial, now: later),
            AgentRunActivityStateReducer.toolCompleted(state: initial, now: later),
            AgentRunActivityStateReducer.waitingForApproval(state: initial, now: later),
            AgentRunActivityStateReducer.waitingForClarification(state: initial, now: later),
            AgentRunActivityStateReducer.appendingToken("Hello", to: initial, now: later),
            AgentRunActivityStateReducer.settingInterimAssistant("Drafting the answer", on: initial, now: later)
        ]

        for state in states {
            XCTAssertFalse(state.isFinal)
            XCTAssertFalse(state.sessionTitle.isEmpty)
            XCTAssertFalse(state.currentActivity.isEmpty)
            XCTAssertGreaterThanOrEqual(state.updatedAt, state.startedAt)
            XCTAssertFalse(
                AgentRunElapsedTimeFormatter.label(
                    startedAt: state.startedAt,
                    updatedAt: state.updatedAt
                ).isEmpty
            )
        }
    }

    func testUpdatingSessionTitlePreservesLiveActivityState() {
        let startedAt = Date(timeIntervalSince1970: 100)
        let state = AgentRunActivityAttributes.ContentState(
            sessionID: "session-abc",
            sessionTitle: "Untitled Session",
            status: .searchingFiles,
            currentActivity: "Searching files",
            responseExcerpt: "Looking through the repo.",
            startedAt: startedAt,
            updatedAt: startedAt,
            isStale: true
        )

        let updated = AgentRunActivityStateReducer.updatingSessionTitle(
            "Generated repo audit title",
            state: state,
            now: Date(timeIntervalSince1970: 130)
        )

        XCTAssertEqual(updated.sessionTitle, "Generated repo audit title")
        XCTAssertEqual(updated.status, .searchingFiles)
        XCTAssertEqual(updated.currentActivity, "Searching files")
        XCTAssertEqual(updated.responseExcerpt, "Looking through the repo.")
        XCTAssertEqual(updated.startedAt, startedAt)
        XCTAssertEqual(updated.updatedAt, Date(timeIntervalSince1970: 130))
        XCTAssertTrue(updated.isStale)
    }

    func testBuildsAndParsesSessionDeepLink() throws {
        let url = try XCTUnwrap(TalariaDeepLink.sessionURL(sessionID: "session-abc"))
        let scheme = TalariaDeepLink.scheme

        XCTAssertEqual(url.scheme, scheme)
        XCTAssertEqual(url.host, "session")
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "session-abc")
        XCTAssertEqual(TalariaDeepLink.sessionID(from: URL(string: "\(scheme)://session/session-xyz")!), "session-xyz")
        XCTAssertNil(TalariaDeepLink.sessionID(from: TalariaShareDraft.openURL))
    }

    func testSessionDeepLinkURLPercentEncodesSessionID() throws {
        let sessionID = "session & /?=✓"
        let url = try XCTUnwrap(TalariaDeepLink.sessionURL(sessionID: sessionID))
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)

        XCTAssertEqual(url.scheme, TalariaDeepLink.scheme)
        XCTAssertEqual(url.host, "session")
        XCTAssertEqual(components?.queryItems, [URLQueryItem(name: "id", value: sessionID)])
        XCTAssertFalse(url.absoluteString.contains(sessionID))
    }

    func testSessionDeepLinkCarriesPublisherForServerRouting() throws {
        let publisherID = "https://hermes.example.com"
        let url = try XCTUnwrap(
            TalariaDeepLink.sessionURL(sessionID: "session-abc", publisherID: publisherID)
        )

        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "session-abc")
        XCTAssertEqual(TalariaDeepLink.publisherID(from: url), publisherID)
    }

    func testChatViewModelLiveActivityLifecycleUsesInjectedManager() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Live work")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Run the tests")
        XCTAssertTrue(didStart)
        XCTAssertEqual(manager.starts, [
            SpyAgentLiveActivityManager.Start(sessionID: "session-abc", sessionTitle: "Live work", streamID: "stream-123")
        ])

        streamClient.emit(.reasoning("I should inspect failures."))
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: nil,
            name: "shell_command",
            preview: nil,
            args: nil,
            duration: nil,
            isError: nil,
            stableID: "call-shell",
            kind: .shell
        )))
        streamClient.emit(.token("Done."))
        streamClient.emit(.toolCompleted(ToolStreamEvent(
            eventType: nil,
            name: "shell_command",
            preview: nil,
            args: nil,
            duration: 1.2,
            isError: false,
            stableID: "call-shell"
        )))
        streamClient.emit(.done(DoneStreamEvent()))

        XCTAssertEqual(manager.updates, [
            .reasoning("I should inspect failures."),
            .toolStarted(kind: .shell, name: "shell_command"),
            .toolCompleted
        ])
        XCTAssertEqual(manager.ends.last, SpyAgentLiveActivityManager.End(
            status: .complete,
            activity: "Response complete",
            errorSummary: nil
        ))
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(viewModel.responseCompletionHapticTrigger, 1)
    }

    // MARK: - Server run start seeding (TAL-163)

    private func makeRunStartViewModel(
        manager: SpyAgentLiveActivityManager,
        streamClient: LiveActivitySpySSEClient
    ) throws -> ChatViewModel {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        return ChatViewModel(
            session: try Self.sessionSummary(id: "session-abc", title: "Live work"),
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: LiveActivitySpySSEClient(),
            clarifyStreamClient: LiveActivitySpySSEClient(),
            liveActivityManager: manager
        )
    }

    func testSendMessageSeedsLiveActivityFromServerPendingStartedAt() async throws {
        let manager = SpyAgentLiveActivityManager()
        let viewModel = try makeRunStartViewModel(manager: manager, streamClient: LiveActivitySpySSEClient())
        LiveActivityURLProtocol.handler = { request in
            Self.jsonResponse(
                #"{"stream_id":"stream-123","session_id":"session-abc","pending_started_at":1700000000.5}"#,
                for: request
            )
        }

        let didStart = await viewModel.sendMessage("Run the tests")

        XCTAssertTrue(didStart)
        XCTAssertEqual(manager.startedAts, [Date(timeIntervalSince1970: 1_700_000_000.5)])
    }

    func testSendMessageFallsBackToSendTimeWhenPendingStartedAtIsUnusable() async throws {
        let manager = SpyAgentLiveActivityManager()
        let viewModel = try makeRunStartViewModel(manager: manager, streamClient: LiveActivitySpySSEClient())
        LiveActivityURLProtocol.handler = { request in
            Self.jsonResponse(
                #"{"stream_id":"stream-123","session_id":"session-abc","pending_started_at":"soon"}"#,
                for: request
            )
        }

        let before = Date()
        let didStart = await viewModel.sendMessage("Run the tests")
        let after = Date()
        XCTAssertTrue(didStart)

        let startedAt = try XCTUnwrap(manager.startedAts.last)
        XCTAssertGreaterThanOrEqual(startedAt, before)
        XCTAssertLessThanOrEqual(startedAt, after)
    }

    func testLoadedSessionAdoptionSeedsLiveActivityFromLatestUserTurnWhenServerStartIsMissing() async throws {
        let manager = SpyAgentLiveActivityManager()
        let streamClient = LiveActivitySpySSEClient()
        let viewModel = try makeRunStartViewModel(manager: manager, streamClient: streamClient)
        LiveActivityURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/session":
                return Self.jsonResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Live work",
                    "active_stream_id": "stream-cold",
                    "pending_started_at": 0,
                    "messages": [
                      {"role": "user", "content": "Earlier", "timestamp": 1770000000, "message_id": "user-0"},
                      {"role": "assistant", "content": "Done", "timestamp": 1770000010, "message_id": "assistant-0"},
                      {"role": "user", "content": "Keep working", "timestamp": 1770000100, "message_id": "user-1"},
                      {"role": "user", "content": "", "timestamp": 1770000150, "message_id": "tool-result-1"}
                    ]
                  }
                }
                """, for: request)
            case "/api/chat/stream/status":
                return Self.jsonResponse(#"{"active":true,"stream_id":"stream-cold"}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.loadMessages(modelContext: nil)
        XCTAssertEqual(viewModel.activeStreamID, "stream-cold")
        await viewModel.reconnectStreamIfNeeded()

        XCTAssertEqual(manager.startedAts, [Date(timeIntervalSince1970: 1_770_000_100)])
    }

    func testChatViewModelSuppressesLiveActivityResponseExcerptsByDefault() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Private live work")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Keep response text private")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Private token."))
        streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(text: "Private interim.", alreadyStreamed: false)))

        XCTAssertTrue(manager.updates.isEmpty)
        XCTAssertTrue(viewModel.messages.contains { $0.content?.contains("Private token.") == true })
    }

    func testChatViewModelCanOptIntoLiveActivityResponseExcerpts() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Visible live work")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager,
            showsLiveActivityResponseExcerpts: true
        )

        let didStart = await viewModel.sendMessage("Show response text")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Visible token."))
        streamClient.emit(.interimAssistant(InterimAssistantStreamEvent(text: "Visible interim.", alreadyStreamed: false)))

        XCTAssertEqual(manager.updates, [
            .token("Visible token."),
            .interimAssistant("Visible interim.")
        ])
    }

    func testDisablingLiveActivityResponseExcerptsClearsActiveExcerpt() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Toggle live work")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager,
            showsLiveActivityResponseExcerpts: true
        )

        let didStart = await viewModel.sendMessage("Toggle response text")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Visible token."))
        viewModel.setShowsLiveActivityResponseExcerpts(false)

        XCTAssertEqual(manager.updates, [
            .token("Visible token."),
            .clearResponseExcerpt
        ])
    }

    func testFollowupMessageStartsNewLiveActivityAfterCompletedResponse() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Live work")
        var nextStreamNumber = 1

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            let streamID = "stream-\(nextStreamNumber)"
            nextStreamNumber += 1
            return Self.jsonResponse(#"{"stream_id":"\#(streamID)","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStartFirstResponse = await viewModel.sendMessage("Run the first answer")
        XCTAssertTrue(didStartFirstResponse)
        streamClient.emit(.token("First answer."))
        streamClient.emit(.done(DoneStreamEvent()))

        XCTAssertEqual(manager.ends, [
            SpyAgentLiveActivityManager.End(
                status: .complete,
                activity: "Response complete",
                errorSummary: nil
            )
        ])
        XCTAssertNil(viewModel.activeStreamID)

        let didStartFollowup = await viewModel.sendMessage("Follow up")
        XCTAssertTrue(didStartFollowup)

        XCTAssertEqual(manager.starts, [
            SpyAgentLiveActivityManager.Start(sessionID: "session-abc", sessionTitle: "Live work", streamID: "stream-1"),
            SpyAgentLiveActivityManager.Start(sessionID: "session-abc", sessionTitle: "Live work", streamID: "stream-2")
        ])
        XCTAssertEqual(viewModel.activeStreamID, "stream-2")
    }

    func testTitleStreamEventUpdatesLiveActivityTitle() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Untitled Session")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Name this run")
        XCTAssertTrue(didStart)

        streamClient.emit(.title(TitleStreamEvent(sessionId: "session-abc", title: "Generated Search Plan")))

        XCTAssertEqual(viewModel.displayTitle, "Generated Search Plan")
        XCTAssertEqual(manager.updates, [
            .sessionTitle("Generated Search Plan")
        ])
    }

    func testDoneSessionTitleUpdatesLiveActivityBeforeCompletion() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Untitled Session")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Finish with a generated title")
        XCTAssertTrue(didStart)

        streamClient.emit(.done(DoneStreamEvent(session: try Self.sessionDetail(id: "session-abc", title: "Generated Finish Plan"))))

        XCTAssertEqual(viewModel.displayTitle, "Generated Finish Plan")
        XCTAssertEqual(manager.updates, [
            .sessionTitle("Generated Finish Plan")
        ])
        XCTAssertEqual(manager.ends.last, SpyAgentLiveActivityManager.End(
            status: .complete,
            activity: "Response complete",
            errorSummary: nil
        ))
    }

    func testStreamEndWithoutDoneStillCompletesLiveActivity() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Live work")

        LiveActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Run the tests")
        XCTAssertTrue(didStart)

        streamClient.emit(.token("Done."))
        streamClient.emit(.streamEnd)

        XCTAssertEqual(manager.ends, [
            SpyAgentLiveActivityManager.End(
                status: .complete,
                activity: "Response complete",
                errorSummary: nil
            )
        ])
        XCTAssertNil(viewModel.activeStreamID)
    }

    func testStatusRefreshCompletionEndsLiveActivityFromCompletedTranscript() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Live work")
        var requestPaths: [String] = []

        LiveActivityURLProtocol.handler = { request in
            requestPaths.append(request.url?.path ?? "")

            switch request.url?.path {
            case "/api/chat/start":
                return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
            case "/api/chat/stream/status":
                return Self.jsonResponse(#"{"active":false,"stream_id":"stream-123"}"#, for: request)
            case "/api/session":
                return Self.jsonResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Live work",
                    "messages": [
                      {
                        "role": "assistant",
                        "content": "Earlier answer.",
                        "timestamp": 1770000000,
                        "message_id": "assistant-0",
                        "_turn_id": "stream-000",
                        "_anchor_activity_scene": {"version": "activity_scene_v1", "activity_rows": [], "final_answer": "Earlier answer.", "terminal_state": "completed"}
                      },
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "Completed from transcript refresh.",
                        "timestamp": 1770000110,
                        "message_id": "assistant-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: nil,
            name: "shell_command",
            preview: nil,
            args: nil,
            duration: nil,
            isError: nil
        )))

        await viewModel.refreshTranscriptIfActiveStreamCompleted(streamID: "stream-123")

        XCTAssertEqual(manager.ends, [
            SpyAgentLiveActivityManager.End(
                status: .complete,
                activity: "Response complete",
                errorSummary: nil
            )
        ])
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(viewModel.responseCompletionHapticTrigger, 1)
        // An earlier turn's scene (from a newer Web before a rollback) does not stop this turn's fallback.
        XCTAssertEqual(viewModel.messages.compactMap(\.content), [
            "Earlier answer.",
            "Keep working",
            "Completed from transcript refresh."
        ])
        XCTAssertEqual(requestPaths, ["/api/chat/start", "/api/chat/stream/status", "/api/session"])
    }

    func testStatusRefreshWithoutFinalAssistantDoesNotCompleteLiveActivity() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Live work")

        LiveActivityURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/chat/start":
                return Self.jsonResponse(#"{"stream_id":"stream-123","session_id":"session-abc"}"#, for: request)
            case "/api/chat/stream/status":
                return Self.jsonResponse(#"{"active":false,"stream_id":"stream-123"}"#, for: request)
            case "/api/session":
                return Self.jsonResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Live work",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStart = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStart)
        streamClient.emit(.toolStarted(ToolStreamEvent(
            eventType: nil,
            name: "shell_command",
            preview: nil,
            args: nil,
            duration: nil,
            isError: nil
        )))

        await viewModel.refreshTranscriptIfActiveStreamCompleted(streamID: "stream-123")

        XCTAssertTrue(manager.ends.isEmpty)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(viewModel.responseCompletionHapticTrigger, 0)
    }

    func testForegroundReconnectCompletionEndsLiveActivityAndAllowsFollowupStream() async throws {
        let baseURL = URL(string: "https://example.test")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LiveActivityURLProtocol.self]
        let client = APIClient(baseURL: baseURL, session: URLSession(configuration: configuration))
        let streamClient = LiveActivitySpySSEClient()
        let approvalStreamClient = LiveActivitySpySSEClient()
        let clarifyStreamClient = LiveActivitySpySSEClient()
        let manager = SpyAgentLiveActivityManager()
        let session = try Self.sessionSummary(id: "session-abc", title: "Live work")
        var nextStreamNumber = 1

        LiveActivityURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/chat/start":
                let streamID = "stream-\(nextStreamNumber)"
                nextStreamNumber += 1
                return Self.jsonResponse(#"{"stream_id":"\#(streamID)","session_id":"session-abc"}"#, for: request)
            case "/api/chat/stream/status":
                return Self.jsonResponse(#"{"active":false,"stream_id":"stream-1","replay_available":false}"#, for: request)
            case "/api/session":
                return Self.jsonResponse("""
                {
                  "session": {
                    "session_id": "session-abc",
                    "title": "Live work",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Keep working",
                        "timestamp": 1770000100,
                        "message_id": "user-1"
                      },
                      {
                        "role": "assistant",
                        "content": "Completed after foreground reconnect.",
                        "timestamp": 1770000110,
                        "message_id": "assistant-1"
                      }
                    ]
                  }
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let viewModel = ChatViewModel(
            session: session,
            server: baseURL,
            client: client,
            streamClient: streamClient,
            approvalStreamClient: approvalStreamClient,
            clarifyStreamClient: clarifyStreamClient,
            liveActivityManager: manager
        )

        let didStartFirstResponse = await viewModel.sendMessage("Keep working")
        XCTAssertTrue(didStartFirstResponse)
        streamClient.emit(.reasoning("Thinking about the final answer."))
        viewModel.suspendStreamForBackground()

        await viewModel.reconnectStreamIfNeeded()

        XCTAssertTrue(manager.didMarkStale)
        XCTAssertEqual(manager.ends, [
            SpyAgentLiveActivityManager.End(
                status: .complete,
                activity: "Response complete",
                errorSummary: nil
            )
        ])
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(streamClient.stopCount, 2)

        let didStartFollowup = await viewModel.sendMessage("Follow up")
        XCTAssertTrue(didStartFollowup)
        XCTAssertEqual(manager.starts, [
            SpyAgentLiveActivityManager.Start(sessionID: "session-abc", sessionTitle: "Live work", streamID: "stream-1"),
            SpyAgentLiveActivityManager.Start(sessionID: "session-abc", sessionTitle: "Live work", streamID: "stream-2")
        ])
        XCTAssertEqual(viewModel.activeStreamID, "stream-2")
    }

    func testFinalLiveActivityStateKeepsExcerptVisible() {
        let startedAt = Date(timeIntervalSince1970: 100)
        let state = AgentRunActivityAttributes.ContentState(
            sessionID: "session-abc",
            sessionTitle: "Live work",
            status: .responding,
            currentActivity: "Writing response",
            responseExcerpt: "Here is the answer.",
            startedAt: startedAt,
            updatedAt: startedAt
        )

        let finalState = AgentRunActivityStateReducer.final(
            status: .complete,
            activity: "Response complete",
            state: state,
            now: Date(timeIntervalSince1970: 120)
        )

        XCTAssertEqual(finalState.status, .complete)
        XCTAssertEqual(finalState.currentActivity, "Response complete")
        XCTAssertEqual(finalState.responseExcerpt, "Here is the answer.")
        XCTAssertTrue(finalState.isFinal)
        XCTAssertFalse(finalState.isStale)
    }

    func testClearingLiveActivityExcerptRemovesRenderableText() {
        let startedAt = Date(timeIntervalSince1970: 100)
        let state = AgentRunActivityAttributes.ContentState(
            sessionID: "session-abc",
            sessionTitle: "Live work",
            status: .responding,
            currentActivity: "Writing response",
            responseExcerpt: "Sensitive answer text.",
            startedAt: startedAt,
            updatedAt: startedAt
        )

        let cleared = AgentRunActivityStateReducer.clearingResponseExcerpt(
            state: state,
            now: Date(timeIntervalSince1970: 130)
        )

        XCTAssertEqual(cleared.status, .responding)
        XCTAssertEqual(cleared.currentActivity, "Writing response")
        XCTAssertTrue(cleared.responseExcerpt.isEmpty)
        XCTAssertEqual(cleared.startedAt, startedAt)
        XCTAssertEqual(cleared.updatedAt, Date(timeIntervalSince1970: 130))
    }

    private static func sessionSummary(id: String, title: String) throws -> SessionSummary {
        let data = Data(#"{"session_id":"\#(id)","title":"\#(title)"}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SessionSummary.self, from: data)
    }

    private static func sessionDetail(id: String, title: String) throws -> SessionDetail {
        let data = Data(#"{"session_id":"\#(id)","title":"\#(title)"}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SessionDetail.self, from: data)
    }

    private static func jsonResponse(_ json: String, for request: URLRequest) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }

    // MARK: - Orphaned activity reconciliation (#246)

    /// Builds a stream-status response for driving the reconciler core. `nil`
    /// `terminalState` omits the `journal` block entirely (the server's shape
    /// when it has no run summary), which the reconciler maps to `.complete`.
    private func statusResponse(active: Bool, terminalState: String? = nil) -> ChatStreamStatusResponse {
        ChatStreamStatusResponse(
            active: active,
            streamId: nil,
            replayAvailable: nil,
            journal: terminalState.map { RunJournalStatus(terminal: true, terminalState: $0) }
        )
    }

    @MainActor
    func testReconcilerEndsOnlyStreamsTheServerReportsInactive() async {
        var ended: [String] = []
        let now = Date(timeIntervalSince1970: 10_000)

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "done", sessionID: "s-done", updatedAt: now),
                OrphanedLiveActivity(streamID: "running", sessionID: "s-running", updatedAt: now),
                OrphanedLiveActivity(streamID: "errored", sessionID: "s-errored", updatedAt: now)
            ],
            now: now,
            notifiesOnCompletion: false,
            streamStatus: { streamID in
                switch streamID {
                case "done": self.statusResponse(active: false)   // server says the run is over → end the orphan
                case "running": self.statusResponse(active: true)  // still active → leave it for the reconnect path
                default: nil                                       // status check failed → leave it (no false positives)
                }
            },
            endOrphan: { orphan, _ in ended.append(orphan.streamID); return true },
            notify: { _, _ in }
        )

        XCTAssertEqual(ended, ["done"])
    }

    @MainActor
    func testReconcilerEndsNothingWhenNoOrphansExist() async {
        var endCount = 0

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [],
            now: Date(timeIntervalSince1970: 10_000),
            notifiesOnCompletion: true,
            streamStatus: { _ in self.statusResponse(active: false) },
            endOrphan: { _, _ in endCount += 1; return true },
            notify: { _, _ in }
        )

        XCTAssertEqual(endCount, 0)
    }

    // #248: on the cold-launch pass, a recently finished orphan also fires a
    // "response complete" notification once it's ended.
    @MainActor
    func testReconcilerNotifiesRecentlyCompletedOrphanOnColdLaunchPass() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var notified: [String] = []

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "recent", sessionID: "s-recent", updatedAt: now.addingTimeInterval(-60))
            ],
            now: now,
            notifiesOnCompletion: true,
            streamStatus: { _ in self.statusResponse(active: false) },
            endOrphan: { _, _ in true },
            notify: { orphan, _ in notified.append(orphan.sessionID) }
        )

        XCTAssertEqual(notified, ["s-recent"])
    }

    // #248: a completion older than the recency window is finalized silently.
    @MainActor
    func testReconcilerEndsButDoesNotNotifyStaleCompletion() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var ended: [String] = []
        var notified: [String] = []

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(
                    streamID: "stale",
                    sessionID: "s-stale",
                    updatedAt: now.addingTimeInterval(-(LiveActivityReconciler.recentCompletionWindow + 1))
                )
            ],
            now: now,
            notifiesOnCompletion: true,
            streamStatus: { _ in self.statusResponse(active: false) },
            endOrphan: { orphan, _ in ended.append(orphan.streamID); return true },
            notify: { orphan, _ in notified.append(orphan.sessionID) }
        )

        XCTAssertEqual(ended, ["stale"])
        XCTAssertTrue(notified.isEmpty)
    }

    // #248 dedup: if another path already finalized the run, `endOrphan` reports it
    // ended nothing here, so the reconciler must not fire a second notification.
    @MainActor
    func testReconcilerDoesNotNotifyWhenAnotherPathAlreadyFinalized() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var notified: [String] = []

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "dup", sessionID: "s-dup", updatedAt: now)
            ],
            now: now,
            notifiesOnCompletion: true,
            streamStatus: { _ in self.statusResponse(active: false) },
            endOrphan: { _, _ in false },   // already final — nothing transitioned here
            notify: { orphan, _ in notified.append(orphan.sessionID) }
        )

        XCTAssertTrue(notified.isEmpty)
    }

    // #248: the foreground pass ends orphans but never notifies — the in-session
    // completion paths own notifications while the app is alive.
    @MainActor
    func testReconcilerForegroundPassEndsOrphansButNeverNotifies() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var ended: [String] = []
        var notified: [String] = []

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "recent", sessionID: "s-recent", updatedAt: now)
            ],
            now: now,
            notifiesOnCompletion: false,
            streamStatus: { _ in self.statusResponse(active: false) },
            endOrphan: { orphan, _ in ended.append(orphan.streamID); return true },
            notify: { orphan, _ in notified.append(orphan.sessionID) }
        )

        XCTAssertEqual(ended, ["recent"])
        XCTAssertTrue(notified.isEmpty)
    }

    // #248: a future-dated completion (clock skew) is treated as not-recent.
    @MainActor
    func testReconcilerDoesNotNotifyFutureDatedCompletion() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var notified: [String] = []

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "future", sessionID: "s-future", updatedAt: now.addingTimeInterval(120))
            ],
            now: now,
            notifiesOnCompletion: true,
            streamStatus: { _ in self.statusResponse(active: false) },
            endOrphan: { _, _ in true },
            notify: { orphan, _ in notified.append(orphan.sessionID) }
        )

        XCTAssertTrue(notified.isEmpty)
    }

    // #267: the journal `terminal_state` → Live Activity outcome mapping. The
    // load-bearing rows are `lost-worker-bookkeeping` → `.failed` (a silently
    // dropped run — the bug this issue fixes) and the unknown/missing fallback →
    // `.complete` (never mislabel a genuine completion as a failure).
    @MainActor
    func testReconciledOutcomeMapsTerminalStateToStatus() {
        func status(_ terminalState: String?) -> AgentRunActivityStatus {
            LiveActivityReconciler.reconciledOutcome(forTerminalState: terminalState).status
        }
        XCTAssertEqual(status("completed"), .complete)
        XCTAssertEqual(status("errored"), .failed)
        XCTAssertEqual(status("interrupted-by-crash"), .failed)
        XCTAssertEqual(status("lost-worker-bookkeeping"), .failed)
        XCTAssertEqual(status("interrupted-by-user"), .cancelled)
        XCTAssertEqual(status("running"), .complete)
        XCTAssertEqual(status("unknown"), .complete)
        XCTAssertEqual(status(nil), .complete)
        XCTAssertEqual(status("a-state-we-have-never-seen"), .complete)

        // The widget line reuses the existing localized completion strings.
        XCTAssertEqual(
            LiveActivityReconciler.reconciledOutcome(forTerminalState: "completed").activity,
            String(localized: "Response complete")
        )
        XCTAssertEqual(
            LiveActivityReconciler.reconciledOutcome(forTerminalState: "errored").activity,
            String(localized: "Response failed")
        )
        XCTAssertEqual(
            LiveActivityReconciler.reconciledOutcome(forTerminalState: "interrupted-by-user").activity,
            String(localized: "Stopped")
        )
    }

    // #267: the core finalizes each orphan with the outcome mapped from the
    // server journal's terminal_state — not an unconditional `.complete`.
    @MainActor
    func testReconcilerFinalizesOrphanWithMappedOutcome() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var endedWith: [String: AgentRunActivityStatus] = [:]

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "ok", sessionID: "s-ok", updatedAt: now),
                OrphanedLiveActivity(streamID: "lost", sessionID: "s-lost", updatedAt: now),
                OrphanedLiveActivity(streamID: "stopped", sessionID: "s-stopped", updatedAt: now)
            ],
            now: now,
            notifiesOnCompletion: false,
            streamStatus: { streamID in
                switch streamID {
                case "ok": self.statusResponse(active: false, terminalState: "completed")
                case "lost": self.statusResponse(active: false, terminalState: "lost-worker-bookkeeping")
                default: self.statusResponse(active: false, terminalState: "interrupted-by-user")
                }
            },
            endOrphan: { orphan, outcome in endedWith[orphan.streamID] = outcome.status; return true },
            notify: { _, _ in }
        )

        XCTAssertEqual(endedWith["ok"], .complete)
        XCTAssertEqual(endedWith["lost"], .failed)
        XCTAssertEqual(endedWith["stopped"], .cancelled)
    }

    // A recently failed run notifies "Response failed"; a user Stop is finalized silently.
    @MainActor
    func testReconcilerNotifiesCompletedAndFailedButNotStoppedOnColdLaunch() async {
        let now = Date(timeIntervalSince1970: 10_000)
        var ended: [String] = []
        var notified: [String] = []
        var outcomes: [ResponseCompletionOutcome] = []

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(streamID: "failed", sessionID: "s-failed", updatedAt: now.addingTimeInterval(-60)),
                OrphanedLiveActivity(streamID: "done", sessionID: "s-done", updatedAt: now.addingTimeInterval(-60)),
                OrphanedLiveActivity(streamID: "stopped", sessionID: "s-stopped", updatedAt: now.addingTimeInterval(-60))
            ],
            now: now,
            notifiesOnCompletion: true,
            streamStatus: { streamID in
                switch streamID {
                case "failed": self.statusResponse(active: false, terminalState: "errored")
                case "done": self.statusResponse(active: false, terminalState: "completed")
                default: self.statusResponse(active: false, terminalState: "interrupted-by-user")
                }
            },
            endOrphan: { orphan, _ in ended.append(orphan.streamID); return true },
            notify: { orphan, outcome in
                notified.append(orphan.sessionID)
                outcomes.append(outcome)
            }
        )

        XCTAssertEqual(ended.sorted(), ["done", "failed", "stopped"])  // all finalized
        XCTAssertEqual(notified, ["s-failed", "s-done"])
        XCTAssertEqual(outcomes, [.failed, .completed])
    }

    // An orphan the journal maps to failed schedules exactly one "Response failed"
    // notification naming its chat.
    @MainActor
    func testReconcilerSchedulesOneFailedNotificationForAFailedOrphan() async {
        let now = Date(timeIntervalSince1970: 10_000)
        let scheduler = SpyResponseCompletionNotificationScheduler(status: .authorized)

        await LiveActivityReconciler.reconcileOrphanedActivities(
            orphans: [
                OrphanedLiveActivity(
                    streamID: "lost",
                    sessionID: "s-lost",
                    updatedAt: now.addingTimeInterval(-60),
                    sessionTitle: "Deploy plan"
                )
            ],
            now: now,
            notifiesOnCompletion: true,
            streamStatus: { _ in self.statusResponse(active: false, terminalState: "lost-worker-bookkeeping") },
            endOrphan: { _, _ in true },
            notify: { orphan, outcome in
                await ResponseCompletionNotificationService.scheduleResponseCompletedIfAllowed(
                    sessionID: orphan.sessionID,
                    chatTitle: orphan.sessionTitle,
                    outcome: outcome,
                    preferenceEnabled: true,
                    sceneIsActive: false,
                    scheduler: scheduler
                )
            }
        )

        XCTAssertEqual(scheduler.scheduledRequests.map(\.title), ["Deploy plan"])
        XCTAssertEqual(scheduler.scheduledRequests.map(\.body), ["Response failed"])
    }

}

@MainActor
private final class SpyAgentLiveActivityManager: AgentLiveActivityManaging {
    struct Start: Equatable {
        let sessionID: String
        let sessionTitle: String
        let streamID: String?
    }

    struct End: Equatable {
        let status: AgentRunActivityStatus
        let activity: String
        let errorSummary: String?
    }

    private(set) var starts: [Start] = []
    private(set) var startedAts: [Date] = []
    private(set) var updates: [AgentLiveActivityEvent] = []
    private(set) var didMarkStale = false
    private(set) var ends: [End] = []

    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date) {
        starts.append(Start(sessionID: sessionID, sessionTitle: sessionTitle, streamID: streamID))
        startedAts.append(startedAt)
    }

    func update(_ event: AgentLiveActivityEvent) {
        updates.append(event)
    }

    func markStale() {
        didMarkStale = true
    }

    func end(status: AgentRunActivityStatus, activity: String, errorSummary: String?) {
        ends.append(End(status: status, activity: activity, errorSummary: errorSummary))
    }
}

private final class LiveActivitySpySSEClient: SSEStreamingClient {
    private var onEvent: (@MainActor (SSEEvent) -> Void)?
    private(set) var startedURLs: [URL] = []
    private(set) var stopCount = 0
    private(set) var lastEventID: String?

    func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        startedURLs.append(url)
        lastEventID = nil
        self.onEvent = onEvent
    }

    func stop() {
        stopCount += 1
    }

    @MainActor
    func emit(_ event: SSEEvent) {
        onEvent?(event)
    }
}

private final class LiveActivityURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
