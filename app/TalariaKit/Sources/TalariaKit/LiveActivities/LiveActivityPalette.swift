/// TAL-2036: how a Live Activity region draws its text and status colours, from the surface under it and how the
/// system renders it. The widget maps these tokens to colours; status symbols and words carry status in every case.
public struct LiveActivityPalette: Equatable, Sendable {
    /// What the region draws on.
    public enum Surface: Sendable {
        /// The fixed near-black card and the Dynamic Island: dark whatever the system appearance.
        case darkCard
        /// The system material behind an iOS 26 Lock Screen activity: light or dark with the system appearance.
        case system
    }

    /// Text and line colour.
    public enum Ink: Equatable, Sendable {
        case white
        case black
        /// The system's primary and secondary styles, for tinted and vibrant rendering.
        case hierarchical
    }

    /// Status colour.
    public enum Tint: Equatable, Sendable {
        /// Bright hues for a dark background.
        case bright
        /// Deeper variants of the same hues for a light background.
        case deep
        /// Secondary ink, for the dimmed Always-On Lock Screen.
        case muted
        /// Primary ink the system tints, for accented and vibrant rendering.
        case accented
    }

    /// Today's look, and the environment default: the dark card in full colour.
    public static let darkCard = LiveActivityPalette(
        surface: .darkCard, isDarkAppearance: true, isFullColor: true, isLuminanceReduced: false, increasedContrast: false
    )

    public let ink: Ink
    /// Raises secondary text and line contrast.
    public let increasedContrast: Bool
    private let hue: Tint
    private let isLuminanceReduced: Bool

    public init(surface: Surface, isDarkAppearance: Bool, isFullColor: Bool, isLuminanceReduced: Bool, increasedContrast: Bool) {
        let isDark = surface == .darkCard || isDarkAppearance
        ink = isFullColor ? (isDark ? .white : .black) : .hierarchical
        hue = isFullColor ? (isDark ? .bright : .deep) : .accented
        self.isLuminanceReduced = isLuminanceReduced
        self.increasedContrast = increasedContrast
    }

    /// Reduced luminance mutes every status except work in progress, which keeps its hue on the dimmed Lock Screen
    /// (TAL-109).
    public func tint(isWorking: Bool) -> Tint {
        isLuminanceReduced && !isWorking ? .muted : hue
    }
}
