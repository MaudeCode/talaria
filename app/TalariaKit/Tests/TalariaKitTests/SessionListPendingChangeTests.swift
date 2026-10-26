import XCTest
import Observation
import SwiftData
@testable import TalariaKit

@MainActor
final class SessionListPendingChangeTests: XCTestCase {
    private var lastServer: URL?
    private var lastClient: APIClient?
    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> SessionListViewModel {
        let host = "pending-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let server = URL(string: "https://\(host)")!
        lastServer = server
        let client = APIClient(baseURL: server, session: URLSession(configuration: config))
        lastClient = client
        return SessionListViewModel(server: server, client: client)
    }
    private let baseline = #"{"sessions":[{"session_id":"same","title":"Original","pinned":false,"can_delete":true,"can_archive":true}]}"#

    func testRemovalsHideImmediatelyAndRefusalsRestoreTheRow() async throws {
        for deleting in [false, true] {
            let requests = DeferredRequests()
            let arrived = expectation(description: "removal held")
            let viewModel = model { request in
                if request.request.url?.path == (deleting ? "/api/session/delete" : "/api/session/archive") {
                    _ = requests.append(request)
                    arrived.fulfill()
                } else { request.complete(withJSON: self.baseline) }
            }
            _ = await viewModel.load()
            let session = try XCTUnwrap(viewModel.sessions.first)
            // Prime the visible-row cache before starting the write.
            XCTAssertEqual(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).count, 1)
            let removal = Task { deleting ? await viewModel.delete(session) : await viewModel.archive(session) }
            await fulfillment(of: [arrived], timeout: 5)
            XCTAssertTrue(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).isEmpty)
            XCTAssertEqual(viewModel.sessions.first?.sessionId, session.sessionId, "Canonical rows wait for the server")
            XCTAssertEqual(viewModel.removingSessionIDs, ["same"])
            requests.request(at: 0).complete(withJSON: #"{"error":"Synthetic refusal"}"#, statusCode: 409)
            let accepted = await removal.value
            XCTAssertFalse(accepted)
            XCTAssertEqual(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).count, 1)
            XCTAssertNil(viewModel.pendingChange(for: session))
            XCTAssertTrue(viewModel.removingSessionIDs.isEmpty)
            XCTAssertNotNil(viewModel.actionErrorMessage)
        }
    }

    func testFreshForkRemovalOutcomeDoesNotDependOnListMembership() async throws {
        for deleting in [false, true] {
            for refused in [false, true] {
                let viewModel = model { request in
                    if request.request.url?.path == (deleting ? "/api/session/delete" : "/api/session/archive") {
                        request.complete(withJSON: refused ? #"{"error":"Synthetic refusal"}"# : #"{"ok":true}"#,
                                         statusCode: refused ? 409 : 200)
                    } else { request.complete(withJSON: self.baseline) }
                }
                _ = await viewModel.load()
                let fork = SessionSummary(sessionId: "fresh-fork")
                XCTAssertFalse(viewModel.sessions.contains { $0.sessionId == fork.sessionId })
                let accepted = deleting ? await viewModel.delete(fork) : await viewModel.archive(fork)
                XCTAssertEqual(accepted, !refused)
                XCTAssertEqual(viewModel.shouldRestoreSessionAfterRemoval("fresh-fork"), refused)
                XCTAssertTrue(viewModel.removingSessionIDs.isEmpty)
            }
        }
    }

    func testUnknownRemovalReconcilesBeforeKeepingOrRollingBackTheRow() async throws {
        for deleted in [false, true] {
            let requests = DeferredRequests()
            let arrived = expectation(description: "removal held")
            let reconcile = expectation(description: "reconcile held")
            let viewModel = model { request in
                if request.request.url?.path == "/api/session/delete" {
                    _ = requests.append(request)
                    arrived.fulfill()
                } else if request.request.url?.path == "/api/session" {
                    _ = requests.append(request)
                    reconcile.fulfill()
                } else { request.complete(withJSON: requests.count > 0 && deleted ? #"{"sessions":[]}"# : self.baseline) }
            }
            _ = await viewModel.load()
            let session = try XCTUnwrap(viewModel.sessions.first)
            let removal = Task { await viewModel.delete(session) }
            await fulfillment(of: [arrived], timeout: 5)
            requests.request(at: 0).fail(with: URLError(.networkConnectionLost))
            await fulfillment(of: [reconcile], timeout: 5)
            XCTAssertTrue(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).isEmpty)
            requests.request(at: 1).complete(withJSON: deleted ? #"{"error":"Session not found"}"# : #"{"session":{"session_id":"same","title":"Original"}}"#,
                                            statusCode: deleted ? 404 : 200)
            let accepted = await removal.value
            XCTAssertEqual(accepted, deleted)
            XCTAssertEqual(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).isEmpty, deleted)
            XCTAssertNil(viewModel.pendingChange(for: session))
            XCTAssertTrue(viewModel.removingSessionIDs.isEmpty)
            XCTAssertEqual(requests.count, 2, "A removal is never replayed blindly")
        }
    }

    func testUnknownArchivedDeleteUsesDetailBeforeRestoringOrPurgingTheChat() async throws {
        for deleted in [false, true] {
            for serverError in [false, true] {
                let requests = DeferredRequests()
                let arrived = expectation(description: "archived delete held")
                let reconciled = expectation(description: "archived detail read")
                let archived = #"{"session_id":"same","title":"Archived chat","archived":true,"can_delete":true}"#
                let viewModel = model { request in
                    switch request.request.url?.path {
                    case "/api/session/delete":
                        _ = requests.append(request)
                        arrived.fulfill()
                    case "/api/session":
                        _ = requests.append(request)
                        reconciled.fulfill()
                    default:
                        request.complete(withJSON: requests.count > 0 && deleted ? #"{"sessions":[]}"# : "{\"sessions\":[\(archived)]}")
                    }
                }
                let container = try ModelContainer(for: CachedSession.self, CachedMessage.self,
                    configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
                let context = container.mainContext
                let server = try XCTUnwrap(lastServer)
                let session = SessionSummary(sessionId: "same", title: "Archived chat", archived: true)
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"Cached archived transcript"}"#.utf8))
                _ = await viewModel.load()
                XCTAssertTrue(viewModel.sessions.isEmpty, "The sidebar excludes archived chats")
                try CacheStore.cacheMessages([message], serverURL: server, sessionID: "same", in: context)
                let version = viewModel.resourceCacheVersion(for: "same")
                var navigation = SessionNavigationState()
                navigation.select(session)
                let previous = navigation
                let removal = Task { await viewModel.delete(session, modelContext: context) }
                await fulfillment(of: [arrived], timeout: 5)
                navigation.remove(sessionID: "same")
                let revision = navigation.openRevision
                XCTAssertNil(navigation.selectedSessionID)
                XCTAssertEqual(viewModel.removingSessionIDs, ["same"])
                if serverError {
                    requests.request(at: 0).complete(withJSON: #"{"error":"Synthetic unknown outcome"}"#, statusCode: 503)
                } else {
                    requests.request(at: 0).fail(with: URLError(.timedOut))
                }
                await fulfillment(of: [reconciled], timeout: 5)
                XCTAssertEqual(requests.count, 2)
                guard requests.count >= 2 else { return }
                XCTAssertEqual(viewModel.resourceCacheVersion(for: "same"), version, "No purge before reconciliation")
                requests.request(at: 1).complete(withJSON: deleted ? #"{"error":"Session not found"}"# : "{\"session\":\(archived)}",
                                                statusCode: deleted ? 404 : 200)
                let accepted = await removal.value
                XCTAssertEqual(accepted, deleted)
                if viewModel.shouldRestoreSessionAfterRemoval("same") {
                    navigation.restoreAfterRemoval(previous, ifUnchangedAt: revision)
                }
                XCTAssertEqual(navigation.selectedSessionID, deleted ? nil : "same", "An existing archived chat must reopen")
                XCTAssertEqual(navigation.destination, deleted ? nil : .session(session), "Restore the archived chat's summary")
                let archivedRows = try await XCTUnwrap(lastClient).sessions(includeArchived: true)
                XCTAssertEqual(archivedRows.sessions?.contains { $0.sessionId == "same" }, !deleted, "The archived row still exists on rollback")
                XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "same", in: context).count, deleted ? 0 : 1)
                XCTAssertEqual(viewModel.resourceCacheVersion(for: "same") == version, !deleted)
                XCTAssertNil(viewModel.pendingChange(for: session))
                XCTAssertTrue(viewModel.removingSessionIDs.isEmpty)
                XCTAssertEqual(requests.count, 2, "Delete is never replayed")
            }
        }
    }

    func testUnknownDeleteWithFailedDetailReadRestoresDisplayUntilNextLoad() async throws {
        for archived in [true, false] {
            let requests = DeferredRequests()
            let arrived = expectation(description: "delete held")
            let reconciled = expectation(description: "detail held")
            let row = "{\"session_id\":\"same\",\"title\":\"Original\",\"archived\":\(archived),\"can_delete\":true}"
            let viewModel = model { request in
                _ = requests.append(request)
                switch request.request.url?.path {
                case "/api/session/delete": arrived.fulfill()
                case "/api/session": reconciled.fulfill()
                default: request.complete(withJSON: "{\"sessions\":[\(row)]}")
                }
            }
            let container = try ModelContainer(for: CachedSession.self, CachedMessage.self,
                configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
            let context = container.mainContext
            let server = try XCTUnwrap(lastServer)
            let session = SessionSummary(sessionId: "same", title: "Original", archived: archived)
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"Cached transcript"}"#.utf8))
            _ = await viewModel.load()
            try CacheStore.cacheMessages([message], serverURL: server, sessionID: "same", in: context)
            let version = viewModel.resourceCacheVersion(for: "same")
            var navigation = SessionNavigationState()
            navigation.select(session)
            let previous = navigation
            let removal = Task { await viewModel.delete(session, modelContext: context) }
            await fulfillment(of: [arrived], timeout: 5)
            navigation.remove(sessionID: "same")
            let revision = navigation.openRevision
            XCTAssertNil(navigation.selectedSessionID)
            XCTAssertEqual(viewModel.removingSessionIDs, ["same"])
            XCTAssertTrue(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).isEmpty)
            requests.request(at: 1).fail(with: URLError(.timedOut))
            await fulfillment(of: [reconciled], timeout: 5)
            XCTAssertEqual(viewModel.removingSessionIDs, ["same"], "Reconcile before rolling back")
            requests.request(at: 2).fail(with: URLError(.networkConnectionLost))
            let accepted = await removal.value
            XCTAssertFalse(accepted)
            if viewModel.shouldRestoreSessionAfterRemoval("same") {
                navigation.restoreAfterRemoval(previous, ifUnchangedAt: revision)
            }
            XCTAssertEqual(navigation.destination, .session(session), "Restore the last confirmed chat")
            XCTAssertTrue(viewModel.removingSessionIDs.isEmpty)
            XCTAssertEqual(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).count, archived ? 0 : 1)
            XCTAssertEqual(viewModel.pendingChange(for: session)?.removing, false)
            XCTAssertEqual(viewModel.pendingChange(for: session)?.requiresRefresh, true)
            XCTAssertEqual(viewModel.actionErrorMessage, APIError.network(underlying: URLError(.timedOut)).localizedDescription)
            XCTAssertEqual(viewModel.resourceCacheVersion(for: "same"), version)
            XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "same", in: context).count, 1)
            XCTAssertEqual(requests.count, 3, "Only the initial list, delete and detail requests were sent")
            XCTAssertEqual(requests.request(at: 1).request.httpMethod, "POST")
            XCTAssertEqual(requests.request(at: 2).request.httpMethod, "GET")
            let repeated = await viewModel.delete(session, modelContext: context)
            XCTAssertFalse(repeated, "An unresolved delete cannot be replayed")
            XCTAssertEqual(requests.count, 3)

            let rows = try await XCTUnwrap(lastClient).sessions(includeArchived: true)
            XCTAssertEqual(rows.sessions?.map(\.sessionId), ["same"], "The archived row remains on the server")
            let loaded = await viewModel.load(modelContext: context)
            XCTAssertTrue(loaded)
            XCTAssertNil(viewModel.pendingChange(for: session), "A successful load releases the unresolved write")
            XCTAssertTrue(viewModel.shouldRestoreSessionAfterRemoval("same"))
            XCTAssertEqual(viewModel.resourceCacheVersion(for: "same"), version)
            XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "same", in: context).count, 1)
            XCTAssertEqual(requests.count, 5, "Reconciliation adds only list reads")
        }
    }

    func testProfileSwitchFencesAnUnknownRemovalReconciliation() async throws {
        let requests = DeferredRequests()
        let removalHeld = expectation(description: "removal held")
        let reconcileHeld = expectation(description: "old profile reconciliation held")
        let empty = #"{"sessions":[]}"#
        let viewModel = model { request in
            switch request.request.url?.path {
            case "/api/session/delete":
                _ = requests.append(request)
                removalHeld.fulfill()
            case "/api/profiles/switch":
                request.complete(withJSON: #"{"active":"other","profiles":[{"name":"other"}]}"#)
            case "/api/session" where requests.count == 1:
                _ = requests.append(request)
                reconcileHeld.fulfill()
            default:
                request.complete(withJSON: empty)
            }
        }
        _ = await viewModel.load()
        // An open/deep-linked chat can be absent from the current list snapshot.
        let session = SessionSummary(sessionId: "same")
        let removal = Task { await viewModel.delete(session) }
        await fulfillment(of: [removalHeld], timeout: 5)
        requests.request(at: 0).fail(with: URLError(.networkConnectionLost))
        await fulfillment(of: [reconcileHeld], timeout: 5)
        let profile = try JSONDecoder().decode(ProfileSummary.self, from: Data(#"{"name":"other"}"#.utf8))
        let switched = await viewModel.switchActiveProfile(profile)
        XCTAssertTrue(switched)
        let replacementCacheVersion = viewModel.resourceCacheVersion(for: "same")
        requests.request(at: 1).complete(withJSON: #"{"error":"Session not found"}"#, statusCode: 404)
        let accepted = await removal.value
        XCTAssertFalse(accepted, "An obsolete profile cannot confirm a removal")
        XCTAssertEqual(viewModel.resourceCacheVersion(for: "same"), replacementCacheVersion,
                       "The obsolete reconciliation must not purge the replacement profile's transcript")
        XCTAssertEqual(viewModel.activeProfileName, "other")
    }

    func testPinIntentSurvivesACoalescedReloadUntilAFreshSnapshotApplies() async throws {
        let requests = DeferredRequests()
        let pinHeld = expectation(description: "pin held")
        let oldRead = expectation(description: "old read held")
        let freshRead = expectation(description: "fresh read held")
        let viewModel = model { request in
            if request.request.url?.path == "/api/session/pin" { _ = requests.append(request); pinHeld.fulfill() }
            else if requests.count == 0 { request.complete(withJSON: self.baseline) }
            else if requests.count == 1 { _ = requests.append(request); oldRead.fulfill() }
            else { _ = requests.append(request); freshRead.fulfill() }
        }
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let pin = Task { await viewModel.setPinned(true, for: session) }
        await fulfillment(of: [pinHeld], timeout: 5)
        XCTAssertEqual(viewModel.pendingChange(for: session)?.pinned, true)
        XCTAssertEqual(viewModel.sessions.first?.pinned, false, "The server's order is retained until its snapshot arrives")
        let stale = Task { await viewModel.load() }
        await fulfillment(of: [oldRead], timeout: 5)
        requests.request(at: 0).complete(withJSON: #"{"ok":true}"#)
        _ = await pin.value
        XCTAssertEqual(viewModel.pendingChange(for: session)?.label, "Pin", "A coalesced reload has not applied a fresh snapshot yet")
        requests.request(at: 1).complete(withJSON: baseline)
        await fulfillment(of: [freshRead], timeout: 5)
        XCTAssertEqual(viewModel.pendingChange(for: session)?.label, "Pin")
        requests.request(at: 2).complete(withJSON: #"{"sessions":[{"session_id":"same","title":"Original","pinned":true}]}"#)
        _ = await stale.value
        XCTAssertEqual(viewModel.sessions.first?.pinned, true)
        XCTAssertNil(viewModel.pendingChange(for: session))
    }

    func testRefusedPinRollsBackItsDisplayChoice() async throws {
        let requests = DeferredRequests()
        let arrived = expectation(description: "pin held")
        let viewModel = model { request in
            if request.request.url?.path == "/api/session/pin" {
                _ = requests.append(request)
                arrived.fulfill()
            } else { request.complete(withJSON: self.baseline) }
        }
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let pin = Task { await viewModel.setPinned(true, for: session) }
        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertEqual(viewModel.pendingChange(for: session)?.pinned, true)
        requests.request(at: 0).complete(withJSON: #"{"error":"Synthetic refusal"}"#, statusCode: 409)
        let accepted = await pin.value
        XCTAssertFalse(accepted)
        XCTAssertNil(viewModel.pendingChange(for: session))
        XCTAssertEqual(viewModel.sessions.first?.pinned, false)
        XCTAssertNotNil(viewModel.actionErrorMessage)
    }

    func testUnknownPinOutcomeReconcilesBeforeDroppingItsDisplayChoice() async throws {
        let requests = DeferredRequests()
        let arrived = expectation(description: "pin held")
        let reconcile = expectation(description: "reconcile held")
        let viewModel = model { request in
            if request.request.url?.path == "/api/session/pin" {
                _ = requests.append(request)
                arrived.fulfill()
            } else if requests.count == 0 { request.complete(withJSON: self.baseline) }
            else { _ = requests.append(request); reconcile.fulfill() }
        }
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let pin = Task { await viewModel.setPinned(true, for: session) }
        await fulfillment(of: [arrived], timeout: 5)
        requests.request(at: 0).fail(with: URLError(.networkConnectionLost))
        await fulfillment(of: [reconcile], timeout: 5)
        XCTAssertEqual(viewModel.pendingChange(for: session)?.pinned, true)
        requests.request(at: 1).complete(withJSON: #"{"sessions":[{"session_id":"same","title":"Original","pinned":true}]}"#)
        let accepted = await pin.value
        XCTAssertFalse(accepted, "The transport outcome remains an error even when the server confirms the pin")
        XCTAssertEqual(viewModel.sessions.first?.pinned, true)
        XCTAssertNil(viewModel.pendingChange(for: session))
        XCTAssertEqual(requests.count, 2, "One pin and one read, with no blind write replay")
    }

    func testRenameKeepsSubmittedTitleSeparateThroughStaleReadThenAdoptsCanonicalTitle() async throws {
        let requests = DeferredRequests()
        let held = expectation(description: "rename held")
        let reload = expectation(description: "stale list held")
        let viewModel = model { request in
            if request.request.url?.path == "/api/session/rename" { _ = requests.append(request); held.fulfill() }
            else if requests.count == 0 { request.complete(withJSON: self.baseline) }
            else { _ = requests.append(request); reload.fulfill() }
        }
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let rename = Task { await viewModel.rename(session, to: "Submitted") }
        await fulfillment(of: [held], timeout: 5)
        XCTAssertEqual(viewModel.pendingChange(for: session)?.title, "Submitted")
        XCTAssertEqual(viewModel.sessions.first?.title, "Original")
        let stale = Task { await viewModel.load() }
        await fulfillment(of: [reload], timeout: 5)
        requests.request(at: 0).complete(withJSON: #"{"session":{"session_id":"same","title":"Canonical"}}"#)
        let renamed = await rename.value
        XCTAssertTrue(renamed)
        requests.request(at: 1).complete(withJSON: baseline)
        _ = await stale.value
        XCTAssertEqual(viewModel.sessions.first?.title, "Canonical")
        XCTAssertNil(viewModel.pendingChange(for: session))
    }

    func testConfirmedDeleteCannotBeResurrectedByAPreWriteReload() async throws {
        let requests = DeferredRequests()
        let deletion = expectation(description: "delete held")
        let oldRead = expectation(description: "old read held")
        let freshRead = expectation(description: "fresh read held")
        let viewModel = model { request in
            switch request.request.url?.path {
            case "/api/session/delete": _ = requests.append(request); deletion.fulfill()
            default:
                if requests.count == 0 { request.complete(withJSON: self.baseline) }
                else if requests.count == 1 { _ = requests.append(request); oldRead.fulfill() }
                else { _ = requests.append(request); freshRead.fulfill() }
            }
        }
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let remove = Task { await viewModel.delete(session) }
        await fulfillment(of: [deletion], timeout: 5)
        XCTAssertEqual(viewModel.pendingChange(for: session)?.label, "Delete")
        let stale = Task { await viewModel.load() }
        await fulfillment(of: [oldRead], timeout: 5)
        let removed = expectation(description: "confirmed row removed")
        withObservationTracking { _ = viewModel.sessions } onChange: { removed.fulfill() }
        requests.request(at: 0).complete(withJSON: #"{"ok":true}"#)
        await fulfillment(of: [removed], timeout: 5)
        requests.request(at: 1).complete(withJSON: baseline)
        await fulfillment(of: [freshRead], timeout: 5)
        XCTAssertTrue(viewModel.sessions.isEmpty)
        requests.request(at: 2).complete(withJSON: #"{"sessions":[]}"#)
        _ = await stale.value
        let didRemove = await remove.value
        XCTAssertTrue(didRemove)
        XCTAssertFalse(viewModel.isMutating(session))
        XCTAssertTrue(viewModel.pendingChanges.isEmpty)
    }

    func testConfirmedDeletePurgesOnlyItsOwnCachedTranscript() async throws {
        let heldDetail = expectation(description: "detail held before deletion")
        heldDetail.expectedFulfillmentCount = 2
        let requests = DeferredRequests()
        let viewModel = model { request in
            if request.request.url?.path == "/api/session" { _ = requests.append(request); heldDetail.fulfill() }
            else if request.request.url?.path == "/api/session/delete" { request.complete(withJSON: #"{"ok":true}"#) }
            else { request.complete(withJSON: #"{"sessions":[]}"#) }
        }
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
        let context = container.mainContext
        let server = try XCTUnwrap(lastServer)
        let otherServer = URL(string: "https://another-server.test")!
        let session = SessionSummary(sessionId: "same", title: "Deleted")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"Cached message"}"#.utf8))
        try CacheStore.cacheSessions([session, SessionSummary(sessionId: "keep")], serverURL: server, in: context)
        for (url, id) in [(server, "same"), (server, "keep"), (otherServer, "same")] {
            try CacheStore.cacheMessages([message], serverURL: url, sessionID: id, in: context)
        }
        let chat = ChatViewModel(session: session, server: server, client: try XCTUnwrap(lastClient), sessionListOwner: viewModel)
        let detail = Task { await chat.loadMessages(modelContext: context) }
        let deepLink = Task { await viewModel.loadSessionForDeepLink(id: "same", modelContext: nil) }
        await fulfillment(of: [heldDetail], timeout: 5)
        _ = await viewModel.delete(session, modelContext: context)
        for index in 0..<2 {
            requests.request(at: index).complete(withJSON: #"{"session":{"session_id":"same","title":"Late deleted detail","messages":[{"role":"user","content":"Late message"}]}}"#)
        }
        await detail.value
        let linked = await deepLink.value
        XCTAssertNil(linked, "A late deep link must not resurrect a confirmed deletion")
        XCTAssertFalse(viewModel.sessions.contains { $0.sessionId == "same" })
        XCTAssertTrue(try CacheStore.cachedMessages(serverURL: server, sessionID: "same", in: context).isEmpty, "Confirmed deletion must purge the deleted transcript")
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "keep", in: context).count, 1)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: otherServer, sessionID: "same", in: context).count, 1)
    }

    func testProfileSwitchFencesOldRenameAndKeepsSameIDActionable() async throws {
        let requests = DeferredRequests()
        let held = expectation(description: "rename held")
        let replacementHeld = expectation(description: "replacement profile rename held")
        let viewModel = model { request in
            switch request.request.url?.path {
            case "/api/session/rename":
                let count = requests.append(request)
                (count == 1 ? held : replacementHeld).fulfill()
            case "/api/profiles/switch": request.complete(withJSON: #"{"active":"other","profiles":[{"name":"other"}]}"#)
            default: request.complete(withJSON: self.baseline)
            }
        }
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let oldChat = ChatViewModel(session: session, server: try XCTUnwrap(lastServer), client: try XCTUnwrap(lastClient), sessionListOwner: viewModel)
        let rename = Task { await viewModel.rename(session, to: "Old profile") }
        await fulfillment(of: [held], timeout: 5)
        let switched = await viewModel.switchActiveProfile(try JSONDecoder().decode(ProfileSummary.self, from: Data(#"{"name":"other"}"#.utf8)))
        XCTAssertTrue(switched)
        requests.request(at: 0).complete(withJSON: #"{"session":{"session_id":"same","title":"Old profile"}}"#)
        let renamed = await rename.value
        XCTAssertFalse(renamed)
        XCTAssertEqual(viewModel.sessions.first?.title, "Original")
        XCTAssertTrue(viewModel.pendingChanges.isEmpty)
        XCTAssertFalse(viewModel.isMutating(session))
        let currentChat = ChatViewModel(session: session, server: try XCTUnwrap(lastServer), client: try XCTUnwrap(lastClient), sessionListOwner: viewModel)
        let replacement = Task { await viewModel.rename(session, to: "New profile") }
        await fulfillment(of: [replacementHeld], timeout: 5)
        XCTAssertNil(oldChat.pendingResourceChange, "An old detail must not display an intent from a replacement profile with the same ID")
        XCTAssertEqual(currentChat.pendingResourceChange?.title, "New profile")
        requests.request(at: 1).complete(withJSON: #"{"session":{"session_id":"same","title":"New profile"}}"#)
        _ = await replacement.value
    }

    func testProjectCreationHasOneProvisionalIntentAndAdoptsOnlyServerIdentity() async throws {
        let requests = DeferredRequests()
        let held = expectation(description: "create held")
        let viewModel = model { request in
            if request.request.url?.path == "/api/projects/create" { _ = requests.append(request); held.fulfill() }
            else { request.complete(withJSON: self.baseline) }
        }
        let create = Task { await viewModel.createEmptyProject(named: "Submitted", color: "#7cb9ff") }
        await fulfillment(of: [held], timeout: 5)
        XCTAssertEqual(viewModel.pendingChanges["project:new"]?.title, "Submitted")
        XCTAssertEqual(viewModel.pendingChanges["project:new"]?.color, "#7cb9ff")
        XCTAssertTrue(viewModel.projects.isEmpty, "A provisional project must not become confirmed membership")
        let duplicate = await viewModel.createEmptyProject(named: "Again", color: "#7cb9ff")
        XCTAssertFalse(duplicate)
        requests.request(at: 0).complete(withJSON: ##"{"project":{"project_id":"canonical-id","name":"Canonical","color":"#50c878"}}"##)
        let created = await create.value
        XCTAssertTrue(created)
        XCTAssertEqual(viewModel.projects.first?.projectId, "canonical-id")
        XCTAssertEqual(viewModel.projects.first?.name, "Canonical")
        XCTAssertNil(viewModel.pendingChanges["project:new"])
    }

    func testBulkReconcilesEachChunkAndRestoresOnlyFailedOrUnknownItems() async throws {
        let requests = DeferredRequests()
        let first = expectation(description: "first chunk held")
        let second = expectation(description: "second chunk held")
        let remaining = #"{"sessions":[{"session_id":"000","title":"Refused","can_delete":true},{"session_id":"200","title":"Unknown","can_delete":true}]}"#
        let viewModel = model { request in
            if request.request.url?.path == "/api/sessions/bulk" {
                let count = requests.append(request)
                (count == 1 ? first : second).fulfill()
            } else { request.complete(withJSON: remaining) }
        }
        let sessions = (0...200).map { SessionSummary(sessionId: String(format: "%03d", $0), canArchive: true, canDelete: true) }
        viewModel.beginSelectingSessions()
        viewModel.toggleSelectAll(sessions)
        let bulk = Task { await viewModel.performBulkAction(.delete) }
        await fulfillment(of: [first], timeout: 5)
        XCTAssertEqual(viewModel.pendingChanges.count, 201)
        let results = (0..<200).map { ["session_id": String(format: "%03d", $0), "ok": $0 != 0] as [String: Any] }
        requests.request(at: 0).complete(withJSON: String(data: try JSONSerialization.data(withJSONObject: ["results":results]), encoding: .utf8)!)
        await fulfillment(of: [second], timeout: 5)
        XCTAssertEqual(Set(viewModel.selectedSessionsByID.keys), ["000", "200"])
        XCTAssertEqual(Set(viewModel.pendingChanges.keys), ["session:200"])
        requests.request(at: 1).fail(with: URLError(.networkConnectionLost))
        let changed = await bulk.value
        XCTAssertEqual(changed.count, 199)
        XCTAssertEqual(Set(viewModel.selectedSessionsByID.keys), ["000", "200"])
        XCTAssertTrue(viewModel.pendingChanges.isEmpty)
        XCTAssertFalse(viewModel.isPerformingBulkAction)
        XCTAssertTrue(viewModel.actionErrorMessage?.contains("2 of 201") == true)
    }

    func testBulkArchivePersistsOneCacheTransactionPerChunk() async throws {
        try await assertBulkCacheTransactions(.archive)
    }

    func testBulkDeletePersistsOneCacheTransactionPerChunk() async throws {
        try await assertBulkCacheTransactions(.delete)
    }

    private func assertBulkCacheTransactions(_ action: SessionBulkAction) async throws {
        let requests = DeferredRequests()
        let first = expectation(description: "first cache chunk held")
        let second = expectation(description: "second cache chunk held")
        let ids = (0...200).map { String(format: "%03d", $0) }
        let rows = (ids + ["keeper"]).map { ["session_id": $0, "title": "Chat \($0)", "can_archive": true, "can_delete": true] as [String: Any] }
        let initial = String(data: try JSONSerialization.data(withJSONObject: ["sessions": rows]), encoding: .utf8)!
        let viewModel = model { request in
            if request.request.url?.path == "/api/sessions/bulk" {
                (requests.append(request) == 1 ? first : second).fulfill()
            } else {
                request.complete(withJSON: requests.count == 0 ? initial : #"{"sessions":[{"session_id":"keeper","title":"Chat keeper"}]}"#)
            }
        }
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
        let context = container.mainContext
        context.autosaveEnabled = false
        let server = try XCTUnwrap(lastServer)
        let otherServer = URL(string: "https://other-bulk-cache.test")!
        _ = await viewModel.load(modelContext: context)
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"role":"user","content":"Keep cached"}"#.utf8))
        for id in ["000", "199", "200", "keeper"] {
            try CacheStore.cacheMessages([message], serverURL: server, sessionID: id, in: context)
        }
        try CacheStore.cacheMessages([message], serverURL: otherServer, sessionID: "000", in: context)
        let saves = BulkCacheSaveCount()
        let contextID = ObjectIdentifier(context)
        let observer = NotificationCenter.default.addObserver(forName: ModelContext.didSave, object: nil, queue: nil) { notification in
            if let object = notification.object as AnyObject?, ObjectIdentifier(object) == contextID { saves.increment() }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        viewModel.beginSelectingSessions()
        viewModel.toggleSelectAll(viewModel.sessions.filter { $0.sessionId != "keeper" })
        let bulk = Task { await viewModel.performBulkAction(action, modelContext: context) }
        await fulfillment(of: [first], timeout: 5)
        let results = ids.prefix(200).map { ["session_id": $0, "ok": true] as [String: Any] }
        requests.request(at: 0).complete(withJSON: String(data: try JSONSerialization.data(withJSONObject: ["results": results]), encoding: .utf8)!)
        await fulfillment(of: [second], timeout: 5)
        XCTAssertEqual(saves.count, 1, "A confirmed chunk must persist its cache once, not once per chat")
        XCTAssertEqual(Set(try CacheStore.cachedSessions(serverURL: server, in: context).compactMap(\.sessionId)), ["200", "keeper"])
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "000", in: context).count, action == .delete ? 0 : 1)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "keeper", in: context).count, 1)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: otherServer, sessionID: "000", in: context).count, 1)
        requests.request(at: 1).complete(withJSON: #"{"results":[{"session_id":"200","ok":true}]}"#)
        let changed = await bulk.value
        XCTAssertEqual(changed.count, 201)
        XCTAssertEqual(saves.count, 3, "Two chunks and one final canonical reload need three cache transactions")
    }

}


private final class BulkCacheSaveCount: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); defer { lock.unlock() }; value += 1 }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}
