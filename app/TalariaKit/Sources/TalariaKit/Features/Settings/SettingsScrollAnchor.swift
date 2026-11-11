/// A Settings destination that an external entry point can open directly.
public enum SettingsScrollAnchor: Hashable, Sendable {
    case servers
    case providerQuotas
    case system

    /// The category the anchor opens; server updates live on the System page.
    public var category: SettingsCategory {
        switch self {
        case .servers: .servers
        case .system: .system
        case .providerQuotas: .providers
        }
    }
}
