#if DEBUG
import Foundation

/// The UI-test fixture's launch contract that TalariaKit code checks: launch arguments and the synthetic server and
/// relay identities. The App's `UITestFixtureEnvironment` builds the fixture itself.
public enum UITestFixtureLaunch {
    /// The fixture arguments every fixture check reads: the process's launch arguments, or the scenario a hosted test
    /// chose for itself (TAL-856).
    nonisolated(unsafe) public static var arguments = ProcessInfo.processInfo.arguments
    public static let launchArgument = "--ui-test-fixture"
    public static let relayConnectedArgument = "--ui-test-relay-connected"
    public static let serverURL = URL(string: "https://ui-test.talaria.invalid")!
    public static var relayCredentials: TalariaRelayCredentials {
        TalariaRelayCredentials(
            baseURL: URL(string: "https://relay.ui-test.invalid")!,
            deviceID: "device-ui-fixture",
            userID: "user-ui-fixture",
            appleUserID: "apple-ui-fixture",
            sessionToken: "session-ui-fixture",
            expiresAt: .distantFuture,
            pairedPublisherIDs: [
                TalariaRelayClient.originURL(serverURL)!.absoluteString,
                "https://removed.ui-test.invalid"
            ]
        )
    }
}
#endif
