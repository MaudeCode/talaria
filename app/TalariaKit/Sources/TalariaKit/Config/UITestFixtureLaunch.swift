#if DEBUG
import Foundation

/// The UI-test fixture's launch contract that TalariaKit code checks: its launch argument and synthetic server.
/// The App's `UITestFixtureEnvironment` builds the fixture itself.
public enum UITestFixtureLaunch {
    public static let launchArgument = "--ui-test-fixture"
    public static let relayRecoveryArgument = "--ui-test-relay-recovery"
    public static let serverURL = URL(string: "https://ui-test.talaria.invalid")!
    /// A second synthetic server, whose session list holds only its own chat (TAL-70).
    public static let secondServerURL = URL(string: "https://ui-test-2.talaria.invalid")!
}
#endif
