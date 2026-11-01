import XCTest
@testable import TalariaKit

/// TAL-48: a shared server that keeps sessions per person reports who is signed
/// in; Talaria shows that person and offers a sign-in path when the person is
/// missing or the login was revoked. Single-user servers show nothing.
@MainActor
final class PersonIdentityTests: XCTestCase {
    private let cookieStorage = URLSessionConfiguration.ephemeral.httpCookieStorage!

    private func decodeStatus(_ json: String) throws -> AuthStatusResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(AuthStatusResponse.self, from: Data(json.utf8))
    }

    private func signedInManager(status: AuthStatusResponse) throws -> (AuthManager, MockAuthAPIClient, URL) {
        let server = URL(string: "https://people.test")!
        let keychain = InMemoryKeychainStore()
        try keychain.save(server.absoluteString, forKey: .serverURL)
        let client = MockAuthAPIClient(authStatus: status)
        let manager = AuthManager(
            keychain: keychain, clientFactory: { _ in client },
            probeClientFactory: { _, _, _ in client }, headerStore: CustomHeaderStore(),
            cookieStorage: cookieStorage, profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: ServerRegistry.inMemory()
        )
        return (manager, client, server)
    }

    func testDetectsThePersonCapabilityAndToleratesOlderOrPartialPayloads() throws {
        let isolated = try decodeStatus("""
        {"auth_enabled": true, "logged_in": true, "person_isolation": {"version": 1, "enabled": true},
         "person": {"id": "oidc:synthetic", "display_name": "alice@example.invalid", "future": 1}}
        """)
        XCTAssertEqual(isolated.personIsolation, PersonIsolationCapability(version: 1, enabled: true))
        XCTAssertEqual(isolated.person, ServerPerson(id: "oidc:synthetic", displayName: "alice@example.invalid"))

        let older = try decodeStatus(#"{"auth_enabled": true, "logged_in": true}"#)
        XCTAssertNil(older.personIsolation)
        XCTAssertNil(older.person)
        XCTAssertNil(AuthManager.activePerson(from: older))

        let personless = try decodeStatus("""
        {"auth_enabled": true, "logged_in": true, "person_isolation": {"version": 1, "enabled": true}, "person": null}
        """)
        XCTAssertEqual(AuthManager.activePerson(from: personless), .unidentified)

        let off = try decodeStatus(#"{"person_isolation": {"version": 1, "enabled": false}}"#)
        XCTAssertNil(AuthManager.activePerson(from: off))
    }

    func testShowsTheServersPersonOnlyForTheServerThatReportedIt() async throws {
        let status = AuthStatusResponse(
            authEnabled: true, loggedIn: true,
            personIsolation: PersonIsolationCapability(version: 1, enabled: true),
            person: ServerPerson(id: "oidc:synthetic", displayName: "alice@example.invalid")
        )
        let (manager, client, _) = try signedInManager(status: status)
        XCTAssertNil(manager.activePerson)

        await manager.refreshActivePerson()
        XCTAssertEqual(manager.activePerson, .signedIn(displayName: "alice@example.invalid"))

        // A different login on the same server is whoever the server now says.
        client.authStatusResponse = AuthStatusResponse(
            authEnabled: true, loggedIn: true,
            personIsolation: PersonIsolationCapability(version: 1, enabled: true),
            person: ServerPerson(id: "oidc:other", displayName: "bob@example.invalid")
        )
        await manager.refreshActivePerson()
        XCTAssertEqual(manager.activePerson, .signedIn(displayName: "bob@example.invalid"))
    }

    func testSingleUserServerShowsNoPerson() async throws {
        let (manager, _, _) = try signedInManager(status: AuthStatusResponse(authEnabled: false, loggedIn: false))
        await manager.refreshActivePerson()
        XCTAssertNil(manager.activePerson)
        XCTAssertNil(manager.pendingReauthentication)
    }

    func testMissingPersonOffersTheNormalSignInSheet() async throws {
        let status = AuthStatusResponse(
            authEnabled: true, loggedIn: true, passwordAuthEnabled: false, oidcEnabled: true, oidcNativeHandoffEnabled: true,
            personIsolation: PersonIsolationCapability(version: 1, enabled: true)
        )
        let (manager, _, server) = try signedInManager(status: status)
        await manager.refreshActivePerson()
        XCTAssertEqual(manager.activePerson, .unidentified)

        manager.reauthenticateActivePerson()
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertTrue(manager.reauthenticationOffersSSO)
        XCTAssertFalse(manager.reauthenticationOffersPassword)
        XCTAssertTrue(manager.reauthenticationIsVoluntary)

        // The session was never lost, so the user can back out with it intact.
        manager.cancelVoluntaryReauthentication()
        XCTAssertNil(manager.pendingReauthentication)
        XCTAssertFalse(manager.reauthenticationIsVoluntary)
        XCTAssertEqual(manager.state, .loggedIn(server: server))
    }

    func testRevokedLoginStartsReauthentication() async throws {
        let (manager, client, server) = try signedInManager(status: AuthStatusResponse(authEnabled: true, loggedIn: true))
        client.authStatusError = APIError.unauthorized
        await manager.refreshActivePerson()
        await manager.recoveryTask?.value
        XCTAssertEqual(manager.pendingReauthentication, server)
        XCTAssertNil(manager.activePerson)
        // A lost session cannot be cancelled back into.
        XCTAssertFalse(manager.reauthenticationIsVoluntary)
        manager.cancelVoluntaryReauthentication()
        XCTAssertEqual(manager.pendingReauthentication, server)
    }
}
