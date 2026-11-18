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
}
