import AppIntents
import Foundation
import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaGaugeStyle {
    let arcColor: Color
    let trackColor: Color
    let lineWidth: Double
    let showsPaceMarker: Bool
    let showsProviderIcon: Bool
    let providerIconStyle: ProviderIconStyle
}


struct ProviderQuotaWidgetSlotLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let frames = ProviderQuotaWidgetSlotGeometry.frames(
            count: subviews.count,
            in: bounds,
            spacing: spacing
        )
        for (subview, frame) in zip(subviews, frames) {
            subview.place(
                at: CGPoint(x: frame.midX, y: frame.midY),
                anchor: .center,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }
}

struct ProviderQuotaWidgetPrimaryDetailLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        for (subview, frame) in zip(
            subviews,
            ProviderQuotaWidgetPrimaryDetailGeometry.frames(in: bounds, spacing: spacing)
        ) {
            subview.place(
                at: CGPoint(x: frame.midX, y: frame.midY),
                anchor: .center,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }
}

enum ProviderQuotaWidgetPrimaryDetailGeometry {
    static func frames(in bounds: CGRect, spacing: CGFloat) -> [CGRect] {
        let availableHeight = max(0, bounds.height - spacing)
        let primaryHeight = min(bounds.width, availableHeight * 0.6)
        return [
            CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: primaryHeight),
            CGRect(
                x: bounds.minX,
                y: bounds.minY + primaryHeight + spacing,
                width: bounds.width,
                height: max(0, availableHeight - primaryHeight)
            ),
        ]
    }
}

enum ProviderQuotaWidgetSlotGeometry {
    static func frames(count: Int, in bounds: CGRect, spacing: CGFloat) -> [CGRect] {
        guard count > 0 else { return [] }
        let columnCount = min(2, count)
        let rowCount = Int(ceil(Double(count) / Double(columnCount)))
        let cellWidth = max(0, (bounds.width - spacing * CGFloat(columnCount - 1)) / CGFloat(columnCount))
        let cellHeight = max(0, (bounds.height - spacing * CGFloat(rowCount - 1)) / CGFloat(rowCount))
        return (0..<count).map { index in
            let column = index % columnCount
            let row = index / columnCount
            return CGRect(
                x: bounds.minX + CGFloat(column) * (cellWidth + spacing),
                y: bounds.minY + CGFloat(row) * (cellHeight + spacing),
                width: cellWidth,
                height: cellHeight
            )
        }
    }
}

enum ProviderQuotaWidgetColorResolver {
    static func color(
        _ value: ProviderQuotaWidgetArcColor,
        customHex: String = ProviderQuotaWidgetAppearanceSettings.defaultCustomArcColorHex,
        automatic: Color = .accentColor
    ) -> Color {
        switch value {
        case .automatic: automatic
        case .accent: .accentColor
        case .blue: .blue
        case .cyan: .cyan
        case .green: .green
        case .indigo: .indigo
        case .mint: .mint
        case .orange: .orange
        case .pink: Color(red: 1.0, green: 0.40, blue: 0.72)
        case .purple: .purple
        case .red: .red
        case .teal: .teal
        case .yellow: .yellow
        case .brown: .brown
        case .gray: .gray
        case .custom: color(hex: customHex)
        }
    }

    static func color(hex: String, fallback: Color = .accentColor) -> Color {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return fallback }
        return Color(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

enum ProviderQuotaWidgetPalette {
    static func arcColor(
        urgency: ProviderQuotaUrgency,
        profile: ProviderQuotaWidgetResolvedProfile
    ) -> Color {
        let configured = ProviderQuotaWidgetArcColor(
            rawValue: profile.string(ProviderQuotaWidgetArcColor.storageKey)
        ) ?? .defaultValue
        guard configured == .automatic else {
            return ProviderQuotaWidgetColorResolver.color(
                configured,
                customHex: profile.string(ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey)
            )
        }
        let role: (String, ProviderQuotaWidgetArcColor, String) = switch urgency {
        case .healthy: (
            ProviderQuotaWidgetAppearanceSettings.healthyColorKey,
            .accent,
            ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey
        )
        case .warning: (
            ProviderQuotaWidgetAppearanceSettings.warningColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey
        )
        case .critical: (
            ProviderQuotaWidgetAppearanceSettings.criticalColorKey,
            .red,
            ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey
        )
        case .stale: (
            ProviderQuotaWidgetAppearanceSettings.staleColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey
        )
        case .unavailable: (
            ProviderQuotaWidgetAppearanceSettings.unavailableColorKey,
            .orange,
            ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey
        )
        }
        return ProviderQuotaWidgetColorResolver.color(
            ProviderQuotaWidgetArcColor(rawValue: profile.string(role.0)) ?? role.1,
            customHex: profile.string(role.2)
        )
    }
}
