import Foundation

public enum GlassPreference {
    public static let isEnabledKey = "adaptiveGlass.isEnabled"
    public static let defaultIsEnabled = true

    public static var isLiquidGlassSupported: Bool {
        if #available(iOS 26, *) {
            return true
        }

        return false
    }

    public static func isEnabled(in defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: isEnabledKey) != nil else {
            return defaultIsEnabled
        }

        return defaults.bool(forKey: isEnabledKey)
    }
}
