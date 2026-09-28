import SwiftUI

public enum KanbanAgeFormatter {
    public static func abbreviated(_ seconds: Double) -> String { format(seconds, style: .abbreviated) }
    static func full(_ seconds: Double) -> String { format(seconds, style: .full) }

    private static func format(_ seconds: Double, style: DateComponentsFormatter.UnitsStyle) -> String {
        let formatter = switch (style, seconds) {
        case (.abbreviated, 86_400...): abbreviatedDays
        case (.abbreviated, 3_600...): abbreviatedHours
        case (.abbreviated, _): abbreviatedMinutes
        case (.full, 86_400...): fullDays
        case (.full, 3_600...): fullHours
        default: fullMinutes
        }
        return formatter.string(from: max(0, seconds)) ?? String(localized: "Just now")
    }

    private static let abbreviatedMinutes = makeFormatter(unit: .minute, style: .abbreviated)
    private static let abbreviatedHours = makeFormatter(unit: .hour, style: .abbreviated)
    private static let abbreviatedDays = makeFormatter(unit: .day, style: .abbreviated)
    private static let fullMinutes = makeFormatter(unit: .minute, style: .full)
    private static let fullHours = makeFormatter(unit: .hour, style: .full)
    private static let fullDays = makeFormatter(unit: .day, style: .full)

    private static func makeFormatter(
        unit: NSCalendar.Unit,
        style: DateComponentsFormatter.UnitsStyle
    ) -> DateComponentsFormatter {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = unit
        formatter.maximumUnitCount = 1
        formatter.unitsStyle = style
        return formatter
    }
}

public enum KanbanCountFormatter {
    public static func cards(_ count: Int) -> String { localized(count, key: "%lld Cards") }
    public static func comments(_ count: Int) -> String { localized(count, key: "%lld comments") }
    public static func prerequisites(_ count: Int) -> String { localized(count, key: "%lld Prerequisites") }
    public static func dependents(_ count: Int) -> String { localized(count, key: "%lld Dependents") }

    private static func localized(_ count: Int, key: String.LocalizationValue) -> String {
        String.localizedStringWithFormat(String(localized: key), count)
    }
}
