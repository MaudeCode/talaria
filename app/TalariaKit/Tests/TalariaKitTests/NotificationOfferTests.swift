import Foundation
import UserNotifications
import XCTest
@testable import TalariaKit

final class NotificationOfferTests: XCTestCase {
    func testFirstComposerRunOffersLocalOrRelayAlerts() {
        XCTAssertEqual(decision(), .local)
        XCTAssertEqual(decision(relayConnected: true), .relay)
    }

    func testAlreadyOfferedSuppressesTheOffer() {
        XCTAssertNil(decision(hasOffered: true))
    }

    func testDeniedPermissionSuppressesTheOffer() {
        XCTAssertNil(decision(authorizationStatus: .denied))
    }

    func testEnabledResponseCompleteAlertsSuppressTheOffer() {
        XCTAssertNil(decision(responseCompletionEnabled: true))
    }

    func testRelayAlertsSuppressTheOfferOnlyForAPairedServer() {
        XCTAssertNil(decision(relayAlertsEnabled: true, relayConnected: true))
        XCTAssertEqual(decision(relayAlertsEnabled: true), .local)
    }

    func testSteerQueueAndSlashCommandsDoNotQualify() {
        for submission: NotificationOffer.Submission in [.streaming(.steer), .streaming(.queue), .slashCommand] {
            XCTAssertNil(decision(after: submission), "Unexpected offer for \(submission)")
        }
    }

    @MainActor func testOfferIsPersistedBeforeTheCallerCanPresentIt() {
        let defaults = UserDefaults.ephemeral("notification-offer")
        let first = NotificationOffer.claim(after: .composer, authorizationStatus: .notDetermined,
                                            relayConnected: false, defaults: defaults)
        XCTAssertEqual(first, .local)
        XCTAssertTrue(defaults.bool(forKey: "notificationOffer.hasOffered"))
        XCTAssertNil(NotificationOffer.claim(after: .composer, authorizationStatus: .notDetermined,
                                             relayConnected: true, defaults: defaults))
    }

    @MainActor func testNotifyMeEnablesResponseCompleteAndLocalApprovalAlerts() async {
        let defaults = UserDefaults.ephemeral("notification-offer-local")
        let granted = await NotificationOffer.local.enable(defaults: defaults, requestAuthorization: { true })
        XCTAssertTrue(granted)
        assertPreferences(defaults, completion: true, localApproval: true, relayApproval: false)
    }

    @MainActor func testTurnOnEnablesResponseCompleteAndRelayApprovalAlerts() async {
        let defaults = UserDefaults.ephemeral("notification-offer-relay")
        let granted = await NotificationOffer.relay.enable(defaults: defaults, requestAuthorization: { true })
        XCTAssertTrue(granted)
        assertPreferences(defaults, completion: true, localApproval: false, relayApproval: true)
    }

    @MainActor func testRefusedAuthorizationLeavesAlertPreferencesOff() async {
        let defaults = UserDefaults.ephemeral("notification-offer-refused")
        let granted = await NotificationOffer.relay.enable(defaults: defaults, requestAuthorization: {
            XCTAssertTrue(defaults.bool(forKey: ResponseCompletionNotifications.hasRequestedPermissionKey))
            return false
        })
        XCTAssertFalse(granted)
        assertPreferences(defaults, completion: false, localApproval: false, relayApproval: false)
    }

    private func decision(
        after submission: NotificationOffer.Submission = .composer, hasOffered: Bool = false,
        authorizationStatus: UNAuthorizationStatus = .notDetermined, responseCompletionEnabled: Bool = false,
        relayAlertsEnabled: Bool = false, relayConnected: Bool = false
    ) -> NotificationOffer? {
        NotificationOffer.decision(
            after: submission, hasOffered: hasOffered, authorizationStatus: authorizationStatus,
            responseCompletionEnabled: responseCompletionEnabled, relayAlertsEnabled: relayAlertsEnabled,
            relayConnected: relayConnected
        )
    }

    private func assertPreferences(
        _ defaults: UserDefaults, completion: Bool, localApproval: Bool, relayApproval: Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(defaults.bool(forKey: ResponseCompletionNotifications.isEnabledKey), completion, file: file, line: line)
        XCTAssertEqual(defaults.bool(forKey: ApprovalNotifications.isEnabledKey), localApproval, file: file, line: line)
        XCTAssertEqual(defaults.bool(forKey: TalariaRelayNotifications.isEnabledKey), relayApproval, file: file, line: line)
    }
}
