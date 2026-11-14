import SwiftUI
import WidgetKit
import TalariaKit

enum AgentRunLiveActivityTheme {
    /// The fixed near-black card iOS 18–25 draws the Lock Screen activity on.
    static let background = Color(red: 0.025, green: 0.028, blue: 0.038)
}

/// TAL-2036: the colours of a `LiveActivityPalette`. Views read the palette from the environment; `liveActivityPalette(on:)`
/// sets it on each Lock Screen and island region.
extension LiveActivityPalette {
    var primaryText: Color {
        switch ink {
        case .white: .white
        case .black: .black
        case .hierarchical: .primary
        }
    }

    var secondaryText: Color {
        switch ink {
        case .white: .white.opacity(increasedContrast ? 0.82 : 0.68)
        case .black: .black.opacity(increasedContrast ? 0.78 : 0.6)
        case .hierarchical: .secondary
        }
    }

    var stroke: Color {
        primaryText.opacity(increasedContrast ? 0.3 : (ink == .white ? 0.13 : 0.12))
    }

    /// The timer pill's faint fill.
    var fill: Color {
        primaryText.opacity(ink == .black ? 0.06 : 0.08)
    }

    /// The working dot beside the timer.
    var liveDot: Color {
        color(for: tint(isWorking: true), bright: Color(red: 0.35, green: 0.95, blue: 0.7), deep: Color(red: 0.06, green: 0.5, blue: 0.32))
    }

    /// The answer buttons keep their hue when dimmed, so a prominent Allow stays readable.
    var actionTint: Color {
        let hue = AgentRunStatusStyle.hue(for: .waitingForApproval)
        return color(for: tint(isWorking: true), bright: hue.bright, deep: hue.deep)
    }

    func color(for status: AgentRunActivityStatus, isStale: Bool) -> Color {
        let hue = isStale ? AgentRunStatusStyle.neutral : AgentRunStatusStyle.hue(for: status)
        return color(for: tint(isWorking: status.isWorking && !isStale), bright: hue.bright, deep: hue.deep)
    }

    /// An aggregate row's phase. Its hues already read on light and dark backgrounds.
    func color(forPhase phase: String) -> Color {
        guard let hex = TalariaAggregateLiveActivityPresentation.colorHex(for: phase) else { return secondaryText }
        let hue = Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        return color(for: tint(isWorking: TalariaAggregateLiveActivityPresentation.isWorking(phase)), bright: hue, deep: hue)
    }

    private func color(for tint: Tint, bright: Color, deep: Color) -> Color {
        switch tint {
        case .bright: bright
        case .deep: deep
        case .muted: secondaryText
        case .accented: primaryText
        }
    }
}

extension LiveActivityPalette.Surface {
    /// iOS 26 and later draws the Lock Screen activity on system material; iOS 18–25 keeps the dark card.
    static var lockScreen: Self {
        if #available(iOS 26, *) { .system } else { .darkCard }
    }

    /// nil asks for the system material.
    var backgroundTint: Color? { self == .darkCard ? AgentRunLiveActivityTheme.background : nil }
    var actionForeground: Color? { self == .darkCard ? .white : nil }
}

extension EnvironmentValues {
    @Entry var liveActivityPalette = LiveActivityPalette.darkCard
}

/// Reads how the system draws this region and hands the matching palette down. ActivityConfiguration's closures get
/// no environment, so the reads live in a modifier.
private struct LiveActivityPaletteScope: ViewModifier {
    let surface: LiveActivityPalette.Surface
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    func body(content: Content) -> some View {
        content.environment(\.liveActivityPalette, LiveActivityPalette(
            surface: surface, isDarkAppearance: colorScheme == .dark, isFullColor: renderingMode == .fullColor,
            isLuminanceReduced: isLuminanceReduced, increasedContrast: contrast == .increased
        ))
    }
}

extension View {
    func liveActivityPalette(on surface: LiveActivityPalette.Surface) -> some View {
        modifier(LiveActivityPaletteScope(surface: surface))
    }
}

enum AgentRunStatusStyle {
    typealias Hue = (bright: Color, deep: Color)

    /// Stale runs.
    static let neutral: Hue = (Color.white.opacity(0.52), Color.black.opacity(0.45))

    /// Bright hues for dark backgrounds, deeper variants of the same hue for light ones.
    static func hue(for status: AgentRunActivityStatus) -> Hue {
        switch status {
        case .starting, .thinking, .responding:
            (Color(red: 1.0, green: 0.82, blue: 0.18), Color(red: 0.54, green: 0.42, blue: 0.0))
        case .usingTool:
            (Color(red: 0.50, green: 0.72, blue: 1.0), Color(red: 0.12, green: 0.37, blue: 0.75))
        case .searchingFiles:
            (Color(red: 0.22, green: 0.92, blue: 0.95), Color(red: 0.0, green: 0.45, blue: 0.48))
        case .readingFiles:
            (Color(red: 0.58, green: 0.78, blue: 1.0), Color(red: 0.17, green: 0.40, blue: 0.70))
        case .runningCommand:
            (Color(red: 0.76, green: 0.55, blue: 1.0), Color(red: 0.42, green: 0.25, blue: 0.72))
        case .waitingForApproval:
            (Color(red: 1.0, green: 0.58, blue: 0.24), Color(red: 0.72, green: 0.35, blue: 0.0))
        case .waitingForClarification:
            (Color(red: 1.0, green: 0.65, blue: 0.30), Color(red: 0.66, green: 0.36, blue: 0.04))
        case .complete:
            (Color(red: 0.35, green: 0.95, blue: 0.55), Color(red: 0.12, green: 0.56, blue: 0.24))
        case .failed:
            (Color(red: 1.0, green: 0.32, blue: 0.32), Color(red: 0.70, green: 0.15, blue: 0.12))
        case .cancelled:
            (Color.white.opacity(0.56), Color.black.opacity(0.45))
        }
    }

    static func symbolName(for status: AgentRunActivityStatus) -> String {
        switch status {
        case .starting:
            "sparkle"
        case .thinking:
            "brain.head.profile"
        case .usingTool:
            "wrench.and.screwdriver"
        case .searchingFiles:
            "magnifyingglass"
        case .readingFiles:
            "doc.text"
        case .runningCommand:
            "terminal"
        case .responding:
            "text.bubble"
        case .waitingForApproval:
            "checkmark.shield"
        case .waitingForClarification:
            "questionmark.bubble"
        case .complete:
            "checkmark"
        case .failed:
            "exclamationmark"
        case .cancelled:
            "xmark"
        }
    }
}

/// Wall clock the running-timer labels read instead of ticking live. Only the
/// visual reference tests set it; a live activity leaves it nil so the system
/// keeps updating the timer without a widget refresh.
extension EnvironmentValues {
    @Entry var agentRunFrozenClock: Date?
}
