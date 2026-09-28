import Foundation
import SwiftUI
#if canImport(UIKit)
#endif

public enum AppTheme: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    public static let storageKey = "appTheme"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system:
            String(localized: "System")
        case .light:
            String(localized: "Light")
        case .dark:
            String(localized: "Dark")
        }
    }

    public var colorScheme: ColorScheme? {
        switch self {
        case .system:
            nil
        case .light:
            .light
        case .dark:
            .dark
        }
    }

    public static func storedValue(_ rawValue: String) -> AppTheme {
        AppTheme(rawValue: rawValue) ?? .system
    }
}

public struct HeaderLogoColorPreset: Identifiable, Equatable {
    public let name: String
    public let hex: String

    public var id: String { hex }

    public var color: Color {
        HeaderLogoColor.color(for: hex)
    }
}

public enum HeaderLogoColor {
    public static let storageKey = "headerLogoColorHex"
    public static let defaultHex = "#FFD700"

    public static let presets: [HeaderLogoColorPreset] = [
        HeaderLogoColorPreset(name: String(localized: "Yellow"), hex: "#FFD700"),
        HeaderLogoColorPreset(name: String(localized: "Blue"), hex: "#5B7CFF"),
        HeaderLogoColorPreset(name: String(localized: "Purple"), hex: "#AF52DE"),
        HeaderLogoColorPreset(name: String(localized: "Red"), hex: "#FF3B30"),
        HeaderLogoColorPreset(name: String(localized: "Green"), hex: "#34C759"),
        HeaderLogoColorPreset(name: String(localized: "White"), hex: "#FFFFFF")
    ]

    public static func normalizedHex(_ rawValue: String) -> String? {
        var hex = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") {
            hex.removeFirst()
        }

        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else {
            return nil
        }

        return "#\(hex.uppercased())"
    }

    public static func color(for rawValue: String) -> Color {
        Color(hexRGB: normalizedHex(rawValue) ?? defaultHex) ?? Color(red: 1.0, green: 0.843, blue: 0.0)
    }

    public static func binding(_ hex: Binding<String>) -> Binding<Color> {
        Binding(
            get: { color(for: hex.wrappedValue) },
            set: { color in
                if let value = hexString(from: color) {
                    hex.wrappedValue = value
                }
            }
        )
    }

    public static func prefersDarkForeground(for rawValue: String) -> Bool {
        guard let components = rgbComponents(for: rawValue) else {
            return true
        }

        let luminance = (0.2126 * components.red) + (0.7152 * components.green) + (0.0722 * components.blue)
        return luminance > 0.62
    }

    public static func displayName(for rawValue: String) -> String {
        let hex = normalizedHex(rawValue) ?? defaultHex
        return presets.first { $0.hex == hex }?.name ?? String(localized: "Custom")
    }

    static func hexString(red: CGFloat, green: CGFloat, blue: CGFloat) -> String {
        String(
            format: "#%02X%02X%02X",
            clampedByte(red),
            clampedByte(green),
            clampedByte(blue)
        )
    }

    static func hexString(from color: Color) -> String? {
        #if canImport(UIKit)
        let uiColor = UIColor(color)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0

        guard uiColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return nil
        }

        return hexString(red: red, green: green, blue: blue)
        #else
        return nil
        #endif
    }

    private static func clampedByte(_ component: CGFloat) -> Int {
        min(255, max(0, Int(round(component * 255))))
    }

    private static func rgbComponents(for rawValue: String) -> (red: Double, green: Double, blue: Double)? {
        guard let hex = normalizedHex(rawValue),
              let value = UInt32(String(hex.dropFirst()), radix: 16)
        else {
            return rgbComponents(for: defaultHex)
        }

        return (
            Double((value & 0xFF0000) >> 16) / 255.0,
            Double((value & 0x00FF00) >> 8) / 255.0,
            Double(value & 0x0000FF) / 255.0
        )
    }
}

extension Color {
    init?(hexRGB rawValue: String) {
        guard let hex = HeaderLogoColor.normalizedHex(rawValue),
              let value = UInt32(String(hex.dropFirst()), radix: 16) else {
            return nil
        }

        self.init(
            red: Double((value & 0xFF0000) >> 16) / 255.0,
            green: Double((value & 0x00FF00) >> 8) / 255.0,
            blue: Double(value & 0x0000FF) / 255.0
        )
    }
}

/// User-facing switch (issue #261) for tinting the primary actions — the
/// "New Chat" button and the composer "Send" button — with the chosen Header
/// Logo Color instead of the default monochrome fill. Defaults to off (opt-in);
/// a control keeps its muted/monochrome look while disabled so a tinted-but-dead
/// button never reads as interactive.
