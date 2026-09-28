#if DEBUG
import Foundation

/// Test-only switch for how the share extension tries to reach the containing app.
/// Nothing else can make `NSExtensionContext.open` fail on demand, and the workaround
/// chain and the manual-open copy behind it are the App Review risk TAL-81 has to
/// validate on the OS versions we ship against.
///
/// The app-side host writes it, the extension reads it, and the shared app group is the
/// only channel the two processes have before the handoff happens.
public enum ShareOpenFixtureMode: String {
    /// Ships as-is: `NSExtensionContext.open` first, workaround only if it fails.
    case normal
    /// Skip `NSExtensionContext.open` so the private-selector workaround runs.
    case workaround
    /// Skip both, so the manual-open fallback copy is the outcome.
    case manualOnly

    static let storageKey = "TalariaShareOpenFixtureMode"

    public static var current: Self {
        guard let raw = UserDefaults(suiteName: TalariaShareDraft.appGroupIdentifier)?
            .string(forKey: storageKey) else {
            return .normal
        }

        return Self(rawValue: raw) ?? .normal
    }

    public static func store(_ mode: Self) {
        UserDefaults(suiteName: TalariaShareDraft.appGroupIdentifier)?
            .set(mode.rawValue, forKey: storageKey)
    }
}
#endif
