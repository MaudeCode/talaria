/// A Settings destination that an external entry point can open directly.
public enum SettingsScrollAnchor: Hashable {
    case servers
    case providerQuotas
    case system

    /// The category the anchor opens; server updates live on the Servers page.
    public var category: SettingsCategory {
        switch self {
        case .servers, .system: .servers
        case .providerQuotas: .providers
        }
    }
}
